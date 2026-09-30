import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  platformReferences,
  repositories,
  run,
  sha256,
  validateImage,
  validateInput,
} from "./release-artifacts.mjs";

// The staging job has already scanned both platforms and preserved the complete
// draft assets. Native runtime acceptance must succeed before this job signs them.
export function verifyNativeArm(
  version,
  gatewayDigest,
  workspaceDigest,
  {
    command = run,
    output = resolve("release-assets"),
    env = process.env,
    architecture = process.arch,
    operatingSystem = process.platform,
  } = {},
) {
  if (architecture !== "arm64" || operatingSystem !== "linux")
    throw new Error("Native Linux ARM64 runner required");
  if (!["aarch64", "arm64"].includes(command("docker", ["info", "--format", "{{.Architecture}}"])))
    throw new Error("Native ARM64 Docker daemon required");
  const revision = command("git", ["rev-parse", "HEAD"]);
  validateInput(version, revision);
  const manifest = JSON.parse(readFileSync(join(output, "artifacts.json"), "utf8"));
  if (
    manifest.version !== version ||
    manifest.revision !== revision ||
    manifest.status !== "verified-public"
  )
    throw new Error("Draft candidate version/source/status mismatch");
  const archive = join(output, `paseo-kubernetes-${version}.tgz`);
  if (sha256(readFileSync(archive)) !== manifest.chart.archiveSha256)
    throw new Error("Draft chart archive mismatch");
  const evidence = { version, revision, platform: "linux/arm64", images: {} };
  for (const [name, digest] of [
    ["gateway", gatewayDigest],
    ["workspace", workspaceDigest],
  ]) {
    if (
      !/^sha256:[a-f0-9]{64}$/.test(digest) ||
      manifest.images[name].digest !== digest ||
      manifest.images[name].repository !== repositories[name]
    )
      throw new Error("Draft candidate image mismatch");
    const image = manifest.images[name];
    const index = JSON.parse(
      command("docker", [
        "buildx",
        "imagetools",
        "inspect",
        "--raw",
        `${image.repository}@${digest}`,
      ]),
    );
    validateImage(index, version, revision);
    const { reference } = platformReferences(image, command, env).find(
      ({ platform }) => platform === "linux/arm64",
    );
    command("docker", ["pull", "--platform", "linux/arm64", reference], { env, stdio: "inherit" });
    if (name === "gateway") {
      command(
        "docker",
        [
          "run",
          "--rm",
          "--platform",
          "linux/arm64",
          "--network=none",
          "--entrypoint",
          "node",
          reference,
          "-e",
          `if(require('/app/package.json').version!==${JSON.stringify(version)})process.exit(1); require('/app/dist/gateway/runtime-status.js')`,
        ],
        { env, stdio: "inherit" },
      );
      // Exercise the exact pulled artifact with its packaged Node command before
      // signing. The portable suite cannot detect this ARM64 optimizer failure.
      const memory = JSON.parse(
        command("node", ["scripts/validator-memory.mjs", reference], { env }),
      );
      if (memory.status !== "PASS" || memory.baseline !== false)
        throw new Error("Gateway validator memory qualification failed");
      evidence.gatewayMemory = memory;
    } else {
      command("npm", ["run", "test:upstream"], {
        env: { ...env, UPSTREAM_TEST_IMAGE: reference, DOCKER_DEFAULT_PLATFORM: "linux/arm64" },
        stdio: "inherit",
      });
    }
    evidence.images[name] = { indexDigest: digest, testedReference: reference };
  }
  writeFileSync(
    join(output, "native-arm64-verification.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return evidence;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  verifyNativeArm(process.argv[2], process.argv[3], process.argv[4]);
