import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { API_VERSION, type CredentialProfile } from "../src/domain.js";
import { PaseoBackend } from "../src/gateway/backend.js";
import { ProviderProbe } from "../src/gateway/provider-probe.js";
import type { Infrastructure } from "../src/kubernetes/store.js";
import { MemoryStore, project } from "../tests/fixtures.js";

// Credential-free, isolated Docker contract for the actual pinned Paseo daemon.
// Kubernetes Pod/Service creation is represented by an in-memory Store. This
// verifies the real SDK wire sequence and cwd, not Kubernetes scheduling.
const runId = randomUUID();
const workspaceId = `catalog-${runId.replace(/-/g, "").slice(0, 24)}`;
const prefix = `paseo-catalog-contract-${runId.slice(0, 8)}`;
const password = randomBytes(32).toString("hex");
const image = process.env.UPSTREAM_TEST_IMAGE ?? "paseo-workspace:dev";
const volumes = [`${prefix}-home`, `${prefix}-checkout`];
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, PASEO_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

class ReadyStore extends MemoryStore {
  override async create(object: Infrastructure) {
    if (object.kind === "Pod" && object.spec && "containers" in object.spec)
      object.status = { phase: "Running", conditions: [{ type: "Ready", status: "True" }] };
    return await super.create(object);
  }
}

let createdContainer = false;
try {
  for (const volume of volumes) docker("volume", "create", volume);
  const setup = `mkdir -p /home/paseo/.paseo /workspaces/${workspaceId}; printf '%s' '{"daemon":{"mcp":{"enabled":false,"injectIntoAgents":false},"relay":{"enabled":false}}}' > /home/paseo/.paseo/config.json; git -C /workspaces/${workspaceId} init --initial-branch=main >/dev/null; printf '%s' 'fixture\n' > /workspaces/${workspaceId}/README.md; git -C /workspaces/${workspaceId} add README.md; git -C /workspaces/${workspaceId} -c user.name=Fixture -c user.email=fixture@example.invalid commit -m fixture >/dev/null; chown -R 1000:1000 /home/paseo /workspaces/${workspaceId}; exec /usr/local/bin/paseo-workspace-entrypoint`;
  docker(
    "run",
    "--detach",
    "--name",
    prefix,
    "--user",
    "0",
    "--publish",
    "127.0.0.1::6767",
    "--env",
    "PASEO_PASSWORD",
    "--env",
    "PASEO_WEB_UI_ENABLED=false",
    "--env",
    "PASEO_HOSTNAMES=127.0.0.1,localhost",
    "--mount",
    `type=volume,source=${volumes[0]},target=/home/paseo`,
    "--mount",
    `type=volume,source=${volumes[1]},target=/workspaces/${workspaceId}`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    setup,
  );
  createdContainer = true;
  const bindings = JSON.parse(
    docker("inspect", "--format", '{{json (index .NetworkSettings.Ports "6767/tcp")}}', prefix),
  );
  const port = Number(bindings[0]?.HostPort);
  assert.ok(Number.isInteger(port) && port > 0);
  const url = `ws://127.0.0.1:${port}/ws`;
  const hello = {
    type: "hello" as const,
    clientId: "catalog-contract",
    clientType: "cli" as const,
    protocolVersion: 1 as const,
  };
  let available = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const backend = new PaseoBackend(
      url,
      password,
      hello,
      () => {},
      () => {},
      () => {},
      5_000,
    );
    try {
      await backend.connect();
      available = true;
      await backend.close();
      break;
    } catch {
      await backend.close().catch(() => {});
      await delay(1_000);
    }
  }
  assert.ok(available, "The isolated daemon did not become reachable");
  const store = new ReadyStore();
  const selectedProject = project();
  selectedProject.metadata.uid = `project-${runId}`;
  const profile: CredentialProfile = {
    apiVersion: API_VERSION,
    kind: "PaseoCredentialProfile",
    metadata: {
      name: selectedProject.spec.credentialProfile,
      namespace: selectedProject.metadata.namespace,
    },
    spec: { env: [], files: [] },
  };
  const probe = new ProviderProbe({
    store,
    namespace: "test",
    backendPassword: password,
    backendSecure: false,
    runtime: {
      workspaceImage: image,
      storageSize: "1Gi",
      backendSecret: "unused",
      imagePullPolicy: "IfNotPresent",
    },
    maxProbeMs: 20_000,
    backendFactory: () => {
      const backend = new PaseoBackend(
        url,
        password,
        hello,
        () => {},
        () => {},
        () => {},
        20_000,
      );
      const request = backend.request.bind(backend);
      backend.request = async (message) => {
        try {
          const response = await request(message);
          console.log(
            JSON.stringify({
              wireRequest: message.type,
              wireResponse: response.type,
              ...(response.type === "get_providers_snapshot_response"
                ? {
                    entryCount: response.payload.entries.length,
                    compactCount: response.payload.compactSnapshot?.entries.length ?? 0,
                    statuses: response.payload.entries.map((entry) => entry.status),
                    compactStatuses:
                      response.payload.compactSnapshot?.entries.map((entry) => entry.status) ?? [],
                  }
                : {}),
            }),
          );
          return response;
        } catch {
          console.log(JSON.stringify({ wireRequest: message.type, wireResponse: "failed" }));
          throw new Error(`Probe wire request failed: ${message.type}`);
        }
      };
      return backend;
    },
  });
  const result = await probe.run({ project: selectedProject, profile, runId });
  assert.ok(result.entries.length > 0);
  assert.ok(result.entries.every((entry) => entry.status !== "loading"));
  assert.equal(result.checkoutStatus.cwd, "/projects/example");
  assert.equal(result.checkoutStatus.isGit, true);
  assert.equal(result.checkoutStatus.repoRoot, "/projects/example");
  assert.equal(result.checkoutStatus.currentBranch, "main");
  assert.equal(result.checkoutStatus.isDirty, false);
  assert.equal(store.objects.size, 0, "Probe-owned fake resources must be cleaned up");
  console.log(
    JSON.stringify({
      result: "PASS",
      wire: "pinned Paseo daemon via PaseoBackend",
      scope: "credential-free Docker",
      checkout: {
        isGit: result.checkoutStatus.isGit,
        logicalPaths: result.checkoutStatus.repoRoot === result.checkoutStatus.cwd,
        branchPresent: !!result.checkoutStatus.currentBranch,
        isDirty: result.checkoutStatus.isDirty,
      },
      providers: result.entries.map((entry) => ({
        status: entry.status,
        modelCount: entry.models?.length ?? 0,
      })),
    }),
  );
} finally {
  const cleanupFailures: string[] = [];
  if (createdContainer) {
    try {
      docker("rm", "--force", prefix);
    } catch {
      cleanupFailures.push("ContainerCleanupFailed");
    }
  }
  for (const volume of volumes) {
    try {
      docker("volume", "rm", volume);
    } catch {
      cleanupFailures.push("VolumeCleanupFailed");
    }
  }
  if (cleanupFailures.length) {
    console.error(JSON.stringify({ cleanupFailures }));
    process.exitCode = 1;
  }
}
