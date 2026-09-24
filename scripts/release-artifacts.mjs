import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const platforms = ["linux/amd64", "linux/arm64"];
export const repositories = {
  gateway: "ghcr.io/manziman/paseo-gateway",
  workspace: "ghcr.io/manziman/paseo-workspace",
  chart: "ghcr.io/manziman/charts/paseo-kubernetes",
};
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function writeChecksums(output) {
  const checksums = readdirSync(output)
    .filter((file) => file !== "SHA256SUMS")
    .sort()
    .map((file) => `${sha256(readFileSync(join(output, file)))}  ${file}`)
    .join("\n");
  writeFileSync(join(output, "SHA256SUMS"), `${checksums}\n`);
}
export function run(command, args, options = {}) {
  return (
    execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    })?.trim() ?? ""
  );
}
export function validateInput(version, revision) {
  if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(version))
    throw new Error("Only alpha prereleases may be published");
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("An exact source commit is required");
}

// Only a confirmed missing manifest permits creation. Authorization/network failures fail closed.
export function inspect(reference, command = run, environment = process.env) {
  try {
    const raw = command("docker", ["buildx", "imagetools", "inspect", "--raw", reference], {
      stdio: "pipe",
    });
    return { raw, manifest: JSON.parse(raw) };
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (
      /manifest unknown|MANIFEST_UNKNOWN|not found/i.test(stderr) &&
      !/unauthorized|denied|forbidden/i.test(stderr)
    )
      return null;
    const repository = reference.replace(/:1\.0\.0-alpha\.1$/, "");
    const bootstrap = (environment.GHCR_BOOTSTRAP_PACKAGES ?? "").split(",");
    if (
      reference === `${repository}:1.0.0-alpha.1` &&
      Object.values(repositories).includes(repository) &&
      bootstrap.includes(repository) &&
      /unauthorized|denied|forbidden/i.test(stderr)
    ) {
      // Owner records an empty package inventory before enabling this one-time allowlist.
      // GHCR returns auth-denied for new names; independently require API absence too.
      const name = encodeURIComponent(repository.replace("ghcr.io/manziman/", ""));
      try {
        command("gh", ["api", `users/manziman/packages/container/${name}`], { stdio: "pipe" });
      } catch (apiError) {
        if (/HTTP 404/.test(String(apiError.stderr ?? ""))) return null;
        throw apiError;
      }
    }
    throw error;
  }
}
export function validateImage(manifest, version, revision) {
  const annotations = manifest.annotations ?? {};
  if (
    annotations["org.opencontainers.image.version"] !== version ||
    annotations["org.opencontainers.image.revision"] !== revision
  ) {
    throw new Error(
      "Existing immutable version belongs to different source; refusing to overwrite",
    );
  }
  for (const platform of platforms) {
    const [os, architecture] = platform.split("/");
    const child = manifest.manifests?.find(
      (entry) => entry.platform?.os === os && entry.platform?.architecture === architecture,
    );
    if (!child) throw new Error(`Image lacks ${platform}`);
    if (
      !manifest.manifests.some(
        (entry) =>
          entry.annotations?.["vnd.docker.reference.digest"] === child.digest &&
          entry.annotations?.["vnd.docker.reference.type"] === "attestation-manifest",
      )
    ) {
      throw new Error(`Image lacks attestations for ${platform}`);
    }
  }
}
export function ensureImage(name, version, revision, output, command = run) {
  const repository = repositories[name];
  const reference = `${repository}:${version}`;
  let image = inspect(reference, command);
  if (!image) {
    command(
      "docker",
      [
        "buildx",
        "build",
        "--file",
        name === "gateway" ? "Dockerfile" : "docker/workspace.Dockerfile",
        "--platform",
        platforms.join(","),
        "--push",
        "--provenance=mode=max",
        "--sbom=true",
        "--build-arg",
        `RELEASE_VERSION=${version}`,
        "--build-arg",
        `RELEASE_REVISION=${revision}`,
        "--annotation",
        `index:org.opencontainers.image.version=${version}`,
        "--annotation",
        `index:org.opencontainers.image.revision=${revision}`,
        "--annotation",
        "index:org.opencontainers.image.source=https://github.com/manziman/paseo-gateway",
        "--tag",
        reference,
        "--metadata-file",
        join(output, `${name}-build.json`),
        ".",
      ],
      { stdio: "inherit" },
    );
    image = inspect(reference, command);
  }
  if (!image) throw new Error(`Missing image after build: ${reference}`);
  validateImage(image.manifest, version, revision);
  // Registry's digest is authoritative; --raw output formatting is not used as a digest calculator.
  const digest = command("docker", [
    "buildx",
    "imagetools",
    "inspect",
    reference,
    "--format",
    "{{json .Manifest.Digest}}",
  ]);
  const resolvedDigest = JSON.parse(digest);
  if (!/^sha256:[a-f0-9]{64}$/.test(resolvedDigest)) throw new Error("Invalid registry digest");
  writeFileSync(join(output, `${name}-index.json`), `${JSON.stringify(image.manifest, null, 2)}\n`);
  return { repository, digest: resolvedDigest };
}
export function verifyImage(name, image, version, output, command = run, env = process.env) {
  const reference = `${image.repository}@${image.digest}`;
  for (const platform of platforms) {
    const architecture = platform.split("/")[1];
    command("docker", ["pull", "--platform", platform, reference], { env, stdio: "inherit" });
    const common = ["run", "--rm", "--platform", platform, "--network=none", "--entrypoint"];
    if (name === "gateway") {
      command(
        "docker",
        [
          ...common,
          "node",
          reference,
          "-e",
          `if(require('/app/package.json').version!==${JSON.stringify(version)})process.exit(1); require('/app/dist/gateway/runtime-status.js')`,
        ],
        { env, stdio: "inherit" },
      );
    } else {
      command(
        "docker",
        [
          ...common,
          "sh",
          reference,
          "-ec",
          "node --version; /usr/local/bin/paseo --version; claude --version; codex --version; opencode --version; /usr/bin/gh --version; git --version",
        ],
        { env, stdio: "inherit" },
      );
    }
    const sources = command(
      "docker",
      [
        ...common,
        "dpkg-query",
        reference,
        "-W",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query format, not a JS template.
        "-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n",
      ],
      { env },
    );
    writeFileSync(join(output, `${name}-${architecture}-debian-sources.tsv`), `${sources}\n`);
    if (name === "workspace") {
      command("npm", ["run", "test:upstream"], {
        env: { ...env, UPSTREAM_TEST_IMAGE: reference, DOCKER_DEFAULT_PLATFORM: platform },
        stdio: "inherit",
      });
    }
    command(
      "trivy",
      [
        "image",
        "--image-src",
        "remote",
        "--platform",
        platform,
        "--scanners",
        "vuln",
        "--format",
        "json",
        "--output",
        join(output, `${name}-${architecture}-vulnerabilities.json`),
        reference,
      ],
      { env, stdio: "inherit" },
    );
    command(
      "trivy",
      [
        "image",
        "--image-src",
        "remote",
        "--platform",
        platform,
        "--scanners",
        "vuln",
        "--severity",
        "HIGH,CRITICAL",
        "--ignore-unfixed",
        "--exit-code",
        "1",
        reference,
      ],
      { env, stdio: "inherit" },
    );
    command(
      "trivy",
      [
        "image",
        "--image-src",
        "remote",
        "--platform",
        platform,
        "--format",
        "spdx-json",
        "--output",
        join(output, `${name}-${architecture}.spdx.json`),
        reference,
      ],
      { env, stdio: "inherit" },
    );
  }
  for (const [kind, template] of [
    ["provenance", "{{json .Provenance}}"],
    ["sbom", "{{json .SBOM}}"],
  ]) {
    const data = command(
      "docker",
      ["buildx", "imagetools", "inspect", reference, "--format", template],
      { env },
    );
    if (!data || data === "null" || data === "{}") throw new Error(`Missing ${kind}: ${reference}`);
    writeFileSync(join(output, `${name}-${kind}.json`), `${data}\n`);
  }
}
export function packageChart(version, images, output, command = run) {
  const staging = mkdtempSync(join(tmpdir(), "paseo-chart-"));
  const chart = join(staging, "paseo");
  cpSync("charts/paseo", chart, { recursive: true });
  const valuesPath = join(chart, "values.yaml");
  const values = YAML.parse(readFileSync(valuesPath, "utf8"));
  Object.assign(values.image, {
    repository: images.gateway.repository,
    tag: version,
    digest: images.gateway.digest,
  });
  Object.assign(values.workspace, {
    image: "",
    repository: images.workspace.repository,
    tag: version,
    digest: images.workspace.digest,
  });
  writeFileSync(valuesPath, YAML.stringify(values));
  command("helm", ["lint", chart], { stdio: "inherit" });
  command(
    "helm",
    ["package", chart, "--version", version, "--app-version", version, "--destination", output],
    { stdio: "inherit" },
  );
  const archive = join(output, `paseo-kubernetes-${version}.tgz`);
  command("python3", ["scripts/release-canonicalize.py", archive]);
  const rendered = command("helm", ["template", "paseo", archive, "--include-crds"]);
  for (const image of Object.values(images)) {
    if (!rendered.includes(`${image.repository}@${image.digest}`))
      throw new Error("Packaged chart does not reference the published image digest");
  }
  writeFileSync(join(output, "rendered-chart.yaml"), `${rendered}\n`);
  return archive;
}
export function ensureChart(version, archive, command = run) {
  const reference = `${repositories.chart}:${version}`;
  if (inspect(reference, command)) {
    const existing = mkdtempSync(join(tmpdir(), "paseo-existing-chart-"));
    command("helm", [
      "pull",
      `oci://${repositories.chart}`,
      "--version",
      version,
      "--destination",
      existing,
    ]);
    if (
      sha256(readFileSync(join(existing, `paseo-kubernetes-${version}.tgz`))) !==
      sha256(readFileSync(archive))
    )
      throw new Error("Existing chart has different bytes; refusing to overwrite");
  } else {
    command("helm", ["push", archive, "oci://ghcr.io/manziman/charts"], { stdio: "inherit" });
  }
  return JSON.parse(
    command("docker", [
      "buildx",
      "imagetools",
      "inspect",
      reference,
      "--format",
      "{{json .Manifest.Digest}}",
    ]),
  );
}
export function anonymousEnvironment() {
  const directory = mkdtempSync(join(tmpdir(), "paseo-anonymous-"));
  writeFileSync(join(directory, "config.json"), "{}\n");
  return {
    ...process.env,
    DOCKER_CONFIG: directory,
    HELM_REGISTRY_CONFIG: join(directory, "helm.json"),
    TRIVY_USERNAME: "",
    TRIVY_PASSWORD: "",
    TRIVY_REGISTRY_TOKEN: "",
  };
}
export async function prepare(version, revision, command = run) {
  validateInput(version, revision);
  if (command("git", ["rev-parse", "HEAD"]) !== revision)
    throw new Error("Release checkout does not match computed source");
  const output = resolve("release-assets");
  // Keep failed candidates visible in workflow artifacts; never claim completion until every verification succeeds.
  command("mkdir", ["-p", output]);
  const images = {};
  for (const name of ["gateway", "workspace"])
    images[name] = ensureImage(name, version, revision, output, command);
  const archive = packageChart(version, images, output, command);
  const chartDigest = ensureChart(version, archive, command);
  const manifest = {
    version,
    revision,
    platforms,
    images,
    chart: {
      repository: repositories.chart,
      digest: chartDigest,
      archiveSha256: sha256(readFileSync(archive)),
    },
    upstreamPaseo: "0.9.1",
    status: "awaiting-public-verification",
  };
  writeFileSync(join(output, "artifacts.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, image] of Object.entries(images))
    verifyImage(name, image, version, output, command);
  const env = anonymousEnvironment();
  for (const image of Object.values(images)) {
    for (const platform of platforms)
      command("docker", ["pull", "--platform", platform, `${image.repository}@${image.digest}`], {
        env,
        stdio: "inherit",
      });
  }
  const anonymous = mkdtempSync(join(tmpdir(), "paseo-chart-pull-"));
  command(
    "helm",
    ["pull", `oci://${repositories.chart}`, "--version", version, "--destination", anonymous],
    { env, stdio: "inherit" },
  );
  if (
    sha256(readFileSync(join(anonymous, `paseo-kubernetes-${version}.tgz`))) !==
    manifest.chart.archiveSha256
  )
    throw new Error("Anonymous chart differs from candidate");
  for (const file of readdirSync("charts/paseo/crds"))
    cpSync(join("charts/paseo/crds", file), join(output, file));
  for (const file of [
    "docs/compatibility.md",
    "docs/redistribution.md",
    "docs/public-installation.md",
    "docs/release-policy.md",
    "docs/releasing.md",
    "NOTICE",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    if (existsSync(file)) cpSync(file, join(output, file.split("/").at(-1)));
  }
  manifest.status = "verified-public";
  writeFileSync(join(output, "artifacts.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeChecksums(output);
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--verify") {
    validateInput(process.argv[3], process.argv[4]);
    if (run("git", ["rev-parse", "HEAD"]) !== process.argv[4])
      throw new Error("Release checkout does not match computed source");
  } else {
    await prepare(process.argv[2], process.argv[3]);
  }
}
