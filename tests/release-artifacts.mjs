import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  ensureChart,
  ensureImage,
  inspect,
  packageChart,
  sha256,
  validateImage,
  validateInput,
  verifyImage,
} from "../scripts/release-artifacts.mjs";

const version = "1.0.0-alpha.1";
const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
function manifest() {
  return {
    annotations: {
      "org.opencontainers.image.version": version,
      "org.opencontainers.image.revision": revision,
    },
    manifests: ["amd64", "arm64"].flatMap((architecture) => [
      { digest: `sha256:${architecture}`, platform: { os: "linux", architecture } },
      {
        annotations: {
          "vnd.docker.reference.digest": `sha256:${architecture}`,
          "vnd.docker.reference.type": "attestation-manifest",
        },
      },
    ]),
  };
}
function missing() {
  throw Object.assign(new Error("missing"), { stderr: "manifest unknown" });
}
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "paseo-artifact-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test("alpha-only source contract rejects stable versions and shell injection", () => {
  validateInput(version, revision);
  for (const bad of ["1.0.0", "v1.0.0-alpha.1", "1.0.0-alpha.1;touch /tmp/bad"])
    assert.throws(() => validateInput(bad, revision));
  assert.throws(() => validateInput(version, "HEAD"));
});
test("registry permission and network failures never mean missing", () => {
  assert.equal(inspect("example", missing), null);
  for (const stderr of ["unauthorized: not found", "denied", "connection refused"])
    assert.throws(() =>
      inspect("example", () => {
        throw Object.assign(new Error(stderr), { stderr });
      }),
    );
});
test("existing images must match original version/revision, both architectures and attestations", () => {
  validateImage(manifest(), version, revision);
  assert.throws(() => validateImage(manifest(), version, "c".repeat(40)));
  const image = manifest();
  image.manifests.pop();
  assert.throws(() => validateImage(image, version, revision), /attestations/);
});
test("image-only interrupted publication recovers without rebuilding or retagging", (t) => {
  const output = temporary(t);
  const calls = [];
  const command = (binary, args) => {
    calls.push([binary, ...args]);
    if (args.includes("--raw")) return JSON.stringify(manifest());
    if (args.includes("--format")) return JSON.stringify(digest);
    throw new Error(`Unexpected mutation: ${args.join(" ")}`);
  };
  assert.equal(ensureImage("gateway", version, revision, output, command).digest, digest);
  assert.equal(
    calls.some((args) => args.includes("build")),
    false,
  );
});
test("new image publication followed by failure can reuse immutable version", (t) => {
  const output = temporary(t);
  let exists = false;
  let builds = 0;
  const command = (_binary, args) => {
    if (args.includes("--raw")) return exists ? JSON.stringify(manifest()) : missing();
    if (args.includes("build")) {
      builds++;
      exists = true;
      return "";
    }
    if (args.includes("--format")) return JSON.stringify(digest);
    throw new Error("Unexpected command");
  };
  ensureImage("workspace", version, revision, output, command);
  ensureImage("workspace", version, revision, output, command);
  assert.equal(builds, 1);
});
test("native Helm packaging is deterministic and embeds exact image digests", (t) => {
  const first = temporary(t);
  const second = temporary(t);
  const images = {
    gateway: { repository: "ghcr.io/manziman/paseo-gateway", digest },
    workspace: { repository: "ghcr.io/manziman/paseo-workspace", digest },
  };
  const one = packageChart(version, images, first);
  const two = packageChart(version, images, second);
  assert.equal(sha256(readFileSync(one)), sha256(readFileSync(two)));
  const metadata = execFileSync("helm", ["show", "chart", one], { encoding: "utf8" });
  assert.match(metadata, /version: 1.0.0-alpha.1/);
  assert.match(metadata, /appVersion: 1.0.0-alpha.1/);
});
test("chart-only recovery compares archive bytes and never replaces mismatched published bytes", (t) => {
  const output = temporary(t);
  const archive = join(output, `paseo-kubernetes-${version}.tgz`);
  writeFileSync(archive, "same immutable bytes");
  let different = false;
  let pushes = 0;
  const command = (binary, args) => {
    if (binary === "docker" && args.includes("--raw")) return "{}";
    if (binary === "docker" && args.includes("--format")) return JSON.stringify(digest);
    if (binary === "helm" && args[0] === "pull") {
      writeFileSync(
        join(args.at(-1), basename(archive)),
        different ? "different bytes" : readFileSync(archive),
      );
      return "";
    }
    pushes++;
    throw new Error("Unexpected publication");
  };
  assert.equal(ensureChart(version, archive, command), digest);
  different = true;
  assert.throws(() => ensureChart(version, archive, command), /different bytes/);
  assert.equal(pushes, 0);
});

test("first-publish GHCR denial needs exact owner allowlist and independent API absence", () => {
  const repository = "ghcr.io/manziman/paseo-gateway";
  const env = { GHCR_BOOTSTRAP_PACKAGES: repository };
  let status = "HTTP 404";
  const command = (binary) => {
    if (binary === "docker") throw Object.assign(new Error("denied"), { stderr: "403 Forbidden" });
    if (status === "exists") return "{}";
    throw Object.assign(new Error(status), { stderr: status });
  };
  assert.equal(inspect(`${repository}:1.0.0-alpha.1`, command, env), null);
  // A source fix after a partially published first candidate reserves a new
  // alpha version; still-missing allowlisted packages must remain creatable.
  assert.equal(inspect(`${repository}:1.0.0-alpha.2`, command, env), null);
  assert.throws(() => inspect(`${repository}:1.0.0`, command, env));
  assert.throws(() => inspect(`${repository}:1.0.0-beta.1`, command, env));
  assert.throws(() => inspect(`${repository}:1.0.0-alpha.1`, command, {}));
  status = "HTTP 403";
  assert.throws(() => inspect(`${repository}:1.0.0-alpha.1`, command, env));
  status = "exists";
  assert.throws(() => inspect(`${repository}:1.0.0-alpha.1`, command, env));
});

// Classic Docker stores can associate a repository digest with only one platform.
// Exercise the complete verification loop with that store contract.
test("verification pulls each platform without overwriting an existing digest", (t) => {
  const output = temporary(t);
  const loaded = new Map();
  const calls = [];
  const index = manifest();
  for (const entry of index.manifests) {
    if (entry.platform)
      entry.digest = `sha256:${(entry.platform.architecture === "amd64" ? "c" : "d").repeat(64)}`;
  }
  const command = (binary, args) => {
    calls.push([binary, ...args]);
    if (args.includes("--raw")) return JSON.stringify(index);
    if (binary === "docker" && args[0] === "pull") {
      const reference = args.at(-1);
      const platform = args[args.indexOf("--platform") + 1];
      if (loaded.has(reference) && loaded.get(reference) !== platform)
        throw new Error(`cannot overwrite digest ${reference}`);
      loaded.set(reference, platform);
    }
    if (args.includes("/inventory.mjs")) return '[{"name":"example","license":"MIT"}]';
    if (args.includes("--format")) return '{"evidence":true}';
    return "";
  };
  verifyImage("gateway", { repository: "example/gateway", digest }, version, output, command);
  assert.equal(loaded.size, 2);
  assert.ok([...loaded.keys()].every((reference) => !reference.endsWith(digest)));
  assert.equal(calls.filter((args) => args[0] === "trivy").length, 6);
});
