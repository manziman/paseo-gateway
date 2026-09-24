import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { compactProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";
import { describe, expect, it } from "vitest";
import { API_VERSION, type CredentialProfile } from "../src/domain.js";
import { workspaceDescriptor } from "../src/gateway/catalog.js";
import { ProviderProbe, publicProviderEntries } from "../src/gateway/provider-probe.js";
import { MemoryStore, project, workspace } from "./fixtures.js";

function input() {
  const row = project();
  row.metadata.uid = "project-uid";
  const profile: CredentialProfile = {
    apiVersion: API_VERSION,
    kind: "PaseoCredentialProfile",
    metadata: { name: "claude-default", namespace: "test" },
    spec: { env: [], files: [] },
  };
  return { row, profile };
}

class ReadyProbeStore extends MemoryStore {
  override async create(object: Parameters<MemoryStore["create"]>[0]) {
    if (object.kind === "Pod" && object.spec && "containers" in object.spec)
      object.status = { phase: "Running", conditions: [{ type: "Ready", status: "True" }] };
    return await super.create(object);
  }
}

describe("provider probe", () => {
  it("expands the pinned daemon's compact-only catalog, sanitizes it, and removes its resources", async () => {
    const store = new ReadyProbeStore();
    const { row, profile } = input();
    const requests: string[] = [];
    const probe = new ProviderProbe({
      store,
      namespace: "test",
      backendPassword: "backend",
      backendSecure: true,
      runtime: {
        workspaceImage: "runtime:v1",
        storageSize: "5Gi",
        backendSecret: "backend",
        imagePullPolicy: "IfNotPresent",
      },
      backendFactory: (url) => {
        expect(url).toMatch(/^wss:\/\/ws-.*\.test\.svc:6767\/ws$/);
        return {
          async connect() {},
          async close() {},
          send() {},
          binary() {},
          async request(message) {
            requests.push(message.type);
            if (message.type === "open_project_request")
              return SessionOutboundMessageSchema.parse({
                type: "open_project_response",
                payload: {
                  requestId: message.requestId,
                  workspace: { ...workspaceDescriptor(workspace(), row), id: "local" },
                  error: null,
                },
              });
            if (message.type === "refresh_providers_snapshot_request")
              return SessionOutboundMessageSchema.parse({
                type: "refresh_providers_snapshot_response",
                payload: { requestId: message.requestId, acknowledged: true },
              });
            if (message.type !== "get_providers_snapshot_request")
              throw new Error("Unexpected probe request");
            return SessionOutboundMessageSchema.parse({
              type: "get_providers_snapshot_response",
              payload: {
                requestId: message.requestId,
                entries: [],
                compactSnapshot: compactProviderSnapshot([
                  {
                    provider: "claude",
                    status: "ready",
                    enabled: true,
                    models: [
                      {
                        provider: "claude",
                        id: "model",
                        label: "Model",
                        metadata: { leaked: "secret" },
                      },
                    ],
                    error: "secret from stderr",
                    iconSvg: "<script>secret</script>",
                    fetchedAt: "2026-01-01T00:00:00.000Z",
                  },
                ]),
                generatedAt: "2026-01-01T00:00:00.000Z",
              },
            });
          },
        };
      },
    });
    const result = await probe.run({
      project: row,
      profile,
      runId: "11111111-2222-4333-8444-555555555555",
    });
    expect(result.entries).toMatchObject([
      { provider: "claude", status: "ready", models: [{ id: "model", label: "Model" }] },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(requests).toEqual([
      "open_project_request",
      "refresh_providers_snapshot_request",
      "get_providers_snapshot_request",
    ]);
    expect([...store.objects.keys()]).toEqual([]);
    expect(store.deletions).toHaveLength(2);
  });

  it("replaces arbitrary provider error text with a fixed category", () => {
    expect(
      publicProviderEntries([
        {
          provider: "opencode",
          status: "error",
          enabled: true,
          error: "Authorization: Bearer secret",
        },
      ]),
    ).toEqual([
      { provider: "opencode", status: "error", enabled: true, error: "Provider catalog error" },
    ]);
  });

  it("preserves exact model routing IDs and bounded public metadata", () => {
    const longId = `model-${"x".repeat(210)}`;
    expect(
      publicProviderEntries([
        {
          provider: "opencode",
          status: "ready",
          enabled: true,
          models: [
            {
              provider: "custom",
              id: longId,
              label: "Custom",
              aliases: ["alias"],
              contextWindowMaxTokens: 128000,
            },
          ],
        },
      ])[0]?.models?.[0],
    ).toMatchObject({
      provider: "custom",
      id: longId,
      aliases: ["alias"],
      contextWindowMaxTokens: 128000,
    });
    expect(() =>
      publicProviderEntries([
        {
          provider: "opencode",
          status: "ready",
          enabled: true,
          models: [
            {
              provider: "opencode",
              id: "x".repeat(257),
              label: "Oversized",
            },
          ],
        },
      ]),
    ).toThrow("too long");
  });

  it("preserves a foreign Pod on create conflict and still removes its own Service", async () => {
    const store = new ReadyProbeStore();
    const { row, profile } = input();
    const runId = "11111111-2222-4333-8444-555555555555";
    const name = ProviderProbe.resourceName(runId);
    store.objects.set(`Pod/${name}`, {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name, uid: "foreign-uid", namespace: "test" },
      spec: { containers: [{ name: "daemon", image: "other" }] },
    });
    const probe = new ProviderProbe({
      store,
      namespace: "test",
      backendPassword: "backend",
      backendSecure: true,
      runtime: {
        workspaceImage: "runtime:v1",
        storageSize: "5Gi",
        backendSecret: "backend",
        imagePullPolicy: "IfNotPresent",
      },
    });
    await expect(probe.run({ project: row, profile, runId })).rejects.toBeDefined();
    expect(store.objects.get(`Pod/${name}`)?.metadata?.uid).toBe("foreign-uid");
    expect(store.objects.has(`Service/${name}`)).toBe(false);
  });

  it("does not delete a replacement Pod with the same run labels but a different UID", async () => {
    const store = new ReadyProbeStore();
    const { row, profile } = input();
    const runId = "11111111-2222-4333-8444-555555555555";
    const probe = new ProviderProbe({
      store,
      namespace: "test",
      backendPassword: "backend",
      backendSecure: true,
      runtime: {
        workspaceImage: "runtime:v1",
        storageSize: "5Gi",
        backendSecret: "backend",
        imagePullPolicy: "IfNotPresent",
      },
    });
    const { providerProbeResources } = await import("../src/gateway/provider-probe-resources.js");
    const resources = providerProbeResources({
      project: row,
      profile,
      runId,
      config: {
        workspaceImage: "runtime:v1",
        storageSize: "5Gi",
        backendSecret: "backend",
        imagePullPolicy: "IfNotPresent",
      },
    });
    resources.pod.metadata ??= { name: resources.name };
    resources.pod.metadata.uid = "replacement-uid";
    store.objects.set(`Pod/${resources.name}`, resources.pod);
    await probe.cleanup(resources.name, "project-uid", runId, { podUid: "original-uid" }, true);
    expect(store.objects.get(`Pod/${resources.name}`)?.metadata?.uid).toBe("replacement-uid");
    expect(store.deletions).toEqual([]);
  });
});
