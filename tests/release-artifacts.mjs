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

function platformManifest() {
  const index = manifest();
  for (const architecture of ["amd64", "arm64"]) {
    const childDigest = `sha256:${(architecture === "amd64" ? "c" : "d").repeat(64)}`;
    const child = index.manifests.find((entry) => entry.platform?.architecture === architecture);
    const attestation = index.manifests.find(
      (entry) => entry.annotations?.["vnd.docker.reference.digest"] === child.digest,
    );
    child.digest = childDigest;
    attestation.annotations["vnd.docker.reference.digest"] = childDigest;
  }
  return index;
}

// Classic Docker stores can associate a repository digest with only one platform.
// Runtime and scanner checks must use the same child that was actually pulled.
for (const name of ["gateway", "workspace"]) {
  test(`${name} verification uses platform children and preserves index attestations`, (t) => {
    const output = temporary(t);
    const image = { repository: `example/${name}`, digest };
    const indexReference = `${image.repository}@${digest}`;
    const index = platformManifest();
    const expected = new Map(
      index.manifests
        .filter((entry) => entry.platform)
        .map((entry) => [
          `${entry.platform.os}/${entry.platform.architecture}`,
          `${image.repository}@${entry.digest}`,
        ]),
    );
    const loaded = new Map();
    const calls = [];
    const env = { RELEASE_TEST: "fixture" };
    const command = (binary, args, options) => {
      calls.push({ binary, args, env: options.env });
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
    verifyImage(name, image, version, output, command, env);
    assert.equal(loaded.size, 2);
    for (const [platform, reference] of expected) {
      assert.equal(loaded.get(reference), platform);
      const platformCalls = calls.filter(
        ({ args }) =>
          args.includes("--platform") && args[args.indexOf("--platform") + 1] === platform,
      );
      assert.equal(platformCalls.filter(({ args }) => args[0] === "pull").length, 1);
      assert.equal(platformCalls.filter(({ args }) => args[0] === "run").length, 3);
      assert.equal(platformCalls.filter(({ binary }) => binary === "trivy").length, 3);
      for (const call of platformCalls) {
        const actualReference =
          call.args[0] === "run"
            ? call.args[call.args.indexOf("--entrypoint") + 2]
            : call.args.at(-1);
        assert.equal(actualReference, reference);
        assert.deepEqual(call.env, env);
      }
    }
    const upstream = calls.filter(({ binary }) => binary === "npm");
    assert.equal(upstream.length, name === "workspace" ? 2 : 0);
    for (const call of upstream) {
      assert.deepEqual(call.args, ["run", "test:upstream"]);
      assert.deepEqual(call.env, {
        ...env,
        DOCKER_DEFAULT_PLATFORM: call.env.DOCKER_DEFAULT_PLATFORM,
        UPSTREAM_TEST_IMAGE: expected.get(call.env.DOCKER_DEFAULT_PLATFORM),
      });
    }
    if (name === "workspace")
      assert.deepEqual(
        upstream.map((call) => call.env.DOCKER_DEFAULT_PLATFORM),
        [...expected.keys()],
      );
    const inspections = calls.filter(({ args }) => args.includes("inspect"));
    assert.deepEqual(
      inspections.map(({ args }) => args),
      [
        ["buildx", "imagetools", "inspect", "--raw", indexReference],
        ["buildx", "imagetools", "inspect", indexReference, "--format", "{{json .Provenance}}"],
        ["buildx", "imagetools", "inspect", indexReference, "--format", "{{json .SBOM}}"],
      ],
    );
    for (const call of inspections) assert.deepEqual(call.env, env);
  });
}

for (const failure of ["missing", "invalid"]) {
  test(`verification fails closed for a ${failure} platform child before pulling or running`, (t) => {
    const output = temporary(t);
    const index = platformManifest();
    if (failure === "missing") {
      index.manifests = index.manifests.filter((entry) => entry.platform?.architecture !== "arm64");
    } else {
      index.manifests.find((entry) => entry.platform?.architecture === "arm64").digest =
        "sha256:bad";
    }
    const calls = [];
    const command = (binary, args) => {
      calls.push([binary, ...args]);
      if (args.includes("--raw")) return JSON.stringify(index);
      throw new Error("Unexpected operation after invalid platform resolution");
    };
    assert.throws(
      () =>
        verifyImage("gateway", { repository: "example/gateway", digest }, version, output, command),
      /Missing or invalid image digest for linux\/arm64/,
    );
    assert.deepEqual(calls, [
      ["docker", "buildx", "imagetools", "inspect", "--raw", `example/gateway@${digest}`],
    ]);
  });
}
