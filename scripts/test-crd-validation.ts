import { spawnSync } from "node:child_process";
import { API_VERSION } from "../src/domain.js";

// Read-only admission probes. Requires the current generated CRDs already installed.
const namespace = process.argv[2] ?? "paseo";
if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) throw new Error("Invalid namespace");
const metadata = { name: `validation-${Date.now()}`, namespace };
const profile = {
  apiVersion: API_VERSION,
  kind: "PaseoCredentialProfile",
  metadata,
  spec: { env: [], files: [] },
};
const secret = { secretKeyRef: { name: "fixture", key: "token" } };
function check(label: string, object: unknown, expected: boolean) {
  const result = spawnSync(
    "kubectl",
    ["--context", "docker-desktop", "create", "--dry-run=server", "-f", "-"],
    { input: JSON.stringify(object), encoding: "utf8" },
  );
  if ((result.status === 0) !== expected)
    throw new Error(
      `CRD admission ${label}: ${expected ? "valid fixture rejected" : "invalid fixture accepted"}`,
    );
  process.stdout.write(`PASS ${label}\n`);
}
check("valid profile", profile, true);
for (const [label, spec] of [
  ["reserved environment", { env: [{ name: "PASEO_PASSWORD", valueFrom: secret }] }],
  [
    "ambiguous reference",
    {
      env: [
        {
          name: "OPENAI_API_KEY",
          valueFrom: { ...secret, configMapKeyRef: { name: "fixture", key: "token" } },
        },
      ],
    },
  ],
  ["missing reference", { env: [{ name: "OPENAI_API_KEY", valueFrom: {} }] }],
  ["path traversal", { files: [{ path: "../escape", valueFrom: secret }] }],
  ["shared Codex login", { files: [{ path: ".codex/auth.json", valueFrom: secret }] }],
  [
    "duplicate env",
    {
      env: [
        { name: "OPENAI_API_KEY", valueFrom: secret },
        { name: "OPENAI_API_KEY", valueFrom: secret },
      ],
    },
  ],
  [
    "overlapping files",
    {
      files: [
        { path: ".config/app", valueFrom: secret },
        { path: ".config/app/key", valueFrom: secret },
      ],
    },
  ],
  ["unsafe file mode", { files: [{ path: ".config/app", mode: 289, valueFrom: secret }] }],
] as const)
  check(label, { ...profile, spec }, false);
const app = {
  appId: 1,
  installationId: 2,
  privateKeySecretRef: { name: "app-private", key: "pem" },
  outputSecretName: "app-output",
  repositories: ["example/repository"],
};
check("valid App", { ...profile, spec: { git: { githubApp: app } } }, true);
check(
  "conflicting Git authority",
  { ...profile, spec: { git: { githubApp: app, tokenSecretRef: secret.secretKeyRef } } },
  false,
);
check(
  "multiple repository owners",
  {
    ...profile,
    spec: { git: { githubApp: { ...app, repositories: ["example/one", "another/two"] } } },
  },
  false,
);
const project = {
  apiVersion: API_VERSION,
  kind: "PaseoProject",
  metadata,
  spec: {
    displayName: "Validation fixture",
    repository: "https://github.com/example/repository.git",
    credentialProfile: "fixture",
  },
};
check("valid project", project, true);
check(
  "embedded HTTPS credentials",
  {
    ...project,
    spec: {
      ...project.spec,
      repository: "https://fixture-token@github.com/example/repository.git",
    },
  },
  false,
);
check(
  "SSH repository",
  { ...project, spec: { ...project.spec, repository: "git@github.com:example/repository.git" } },
  true,
);
check(
  "cache traversal",
  { ...project, spec: { ...project.spec, cache: { claimName: "cache", subPath: "../outside" } } },
  false,
);
