import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { repositories, sha256 } from "../scripts/release-artifacts.mjs";
import { verifyNativeArm } from "../scripts/release-native-arm.mjs";

const version = "1.0.0-alpha.3";
const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const child = `sha256:${"c".repeat(64)}`;
function fixture(t) {
  const output = mkdtempSync(join(tmpdir(), "paseo-native-arm-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const manifest = {
    version,
    revision,
    status: "verified-public",
    chart: { archiveSha256: sha256("chart fixture") },
    images: {
      gateway: { repository: repositories.gateway, digest },
      workspace: { repository: repositories.workspace, digest },
    },
  };
  writeFileSync(join(output, "artifacts.json"), JSON.stringify(manifest));
  writeFileSync(join(output, `paseo-kubernetes-${version}.tgz`), "chart fixture");
  const calls = [];
  const command = (binary, args, options = {}) => {
    calls.push({ binary, args, options });
    if (binary === "git") return revision;
    if (binary === "docker" && args[0] === "info") return "aarch64";
    if (args.includes("--raw"))
      return JSON.stringify({
        annotations: {
          "org.opencontainers.image.version": version,
          "org.opencontainers.image.revision": revision,
        },
        manifests: ["amd64", "arm64"].flatMap((architecture) => [
          { digest: child, platform: { os: "linux", architecture } },
          {
            annotations: {
              "vnd.docker.reference.digest": child,
              "vnd.docker.reference.type": "attestation-manifest",
            },
          },
        ]),
      });
    return "";
  };
  return {
    output,
    manifest,
    calls,
    command,
    options: { output, command, architecture: "arm64", operatingSystem: "linux", env: {} },
  };
}
test("native ARM gate verifies pinned source and both exact image children before recording acceptance", (t) => {
  const f = fixture(t);
  const evidence = verifyNativeArm(version, digest, digest, f.options);
  assert.equal(evidence.images.gateway.testedReference, `${repositories.gateway}@${child}`);
  assert.equal(evidence.images.workspace.testedReference, `${repositories.workspace}@${child}`);
  assert.equal(existsSync(join(f.output, "native-arm64-verification.json")), true);
  const upstream = f.calls.filter(({ binary }) => binary === "npm");
  assert.equal(upstream.length, 1);
  assert.deepEqual(upstream[0].options.env, {
    DOCKER_DEFAULT_PLATFORM: "linux/arm64",
    UPSTREAM_TEST_IMAGE: `${repositories.workspace}@${child}`,
  });
});
test("native ARM gate rejects substituted chart bytes before running candidate images", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.output, `paseo-kubernetes-${version}.tgz`), "substituted chart");
  assert.throws(
    () => verifyNativeArm(version, digest, digest, f.options),
    /chart archive mismatch/,
  );
  assert.equal(
    f.calls.some(({ args }) => args[0] === "pull" || args[0] === "run"),
    false,
  );
});
test("native ARM gate rejects emulation host before pulling or executing artifacts", (t) => {
  const f = fixture(t);
  assert.throws(
    () => verifyNativeArm(version, digest, digest, { ...f.options, architecture: "x64" }),
    /Native Linux ARM64/,
  );
  assert.equal(f.calls.length, 0);
});
test("native ARM gate rejects source/digest drift and propagates daemon failures without a success record", (t) => {
  const f = fixture(t);
  assert.throws(
    () => verifyNativeArm(version, digest, `sha256:${"d".repeat(64)}`, f.options),
    /image mismatch/,
  );
  f.manifest.revision = "e".repeat(40);
  writeFileSync(join(f.output, "artifacts.json"), JSON.stringify(f.manifest));
  assert.throws(() => verifyNativeArm(version, digest, digest, f.options), /source/);
  f.manifest.revision = revision;
  writeFileSync(join(f.output, "artifacts.json"), JSON.stringify(f.manifest));
  assert.throws(
    () =>
      verifyNativeArm(version, digest, digest, {
        ...f.options,
        command(binary, args, options) {
          if (binary === "npm") throw new Error("daemon failed");
          return f.command(binary, args, options);
        },
      }),
    /daemon failed/,
  );
  assert.equal(existsSync(join(f.output, "native-arm64-verification.json")), false);
});
test("workflow requires native ARM acceptance before signing and keeps no-release runs idle", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/release.yaml", "utf8"));
  const native = workflow.jobs["native-arm"];
  assert.equal(native["runs-on"], "ubuntu-24.04-arm");
  assert.deepEqual(native.needs, ["publish"]);
  assert.equal(native.if, "needs.publish.outputs.version != ''");
  assert.equal(
    workflow.jobs.publish.steps.some((step) => step.uses?.startsWith("actions/attest@")),
    false,
  );
  const testIndex = native.steps.findIndex((step) =>
    step.run?.includes("node scripts/release-native-arm.mjs"),
  );
  const signing = native.steps
    .map((step, index) => (step.uses?.startsWith("actions/attest@") ? index : -1))
    .filter((index) => index >= 0);
  assert.ok(testIndex >= 0);
  assert.equal(native.steps[testIndex].if, undefined);
  assert.equal(signing.length, 3);
  assert.equal(
    native.steps[signing[2]].with["subject-path"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression.
    "release-assets/paseo-kubernetes-${{ needs.publish.outputs.version }}.tgz",
  );
  const download = native.steps.find(
    (step) => step.name === "Download and verify the staged qualification draft",
  );
  assert.match(download.run, /CHECKSUMS_DIGEST/);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression.
  assert.equal(native.env.CHECKSUMS_DIGEST, "${{ needs.publish.outputs.checksums }}");
  assert.ok(signing.every((index) => index > testIndex));
  assert.equal(native.steps[testIndex].continueOnError, undefined);
  assert.equal(native.steps[testIndex]["continue-on-error"], undefined);
});
