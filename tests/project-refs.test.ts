import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { API_VERSION, type CredentialProfile } from "../src/domain.js";
import { DirectoryGeneration } from "../src/gateway/catalog.js";
import { ProjectRefInspector } from "../src/gateway/project-refs.js";
import { GatewaySession } from "../src/gateway/session.js";
import type { ControlRecord } from "../src/kubernetes/records.js";
import { MemoryStore, project } from "./fixtures.js";

const runtime = {
  workspaceImage: "workspace:default",
  storageSize: "5Gi",
  backendSecret: "backend",
  imagePullPolicy: "IfNotPresent" as const,
};
const profile: CredentialProfile = {
  apiVersion: API_VERSION,
  kind: "PaseoCredentialProfile",
  metadata: { name: "claude-default", namespace: "test", uid: "profile-uid" },
  spec: { env: [], files: [] },
};

class FinishedRefStore extends MemoryStore {
  result: unknown = { version: 1, refs: ["feature/new", "main"] };
  createdPods: Parameters<MemoryStore["create"]>[0][] = [];
  control = new Map<string, ControlRecord>();
  async records<T>(kind: string) {
    return structuredClone(
      [...this.control.values()].filter((row) => row.kind === kind),
    ) as ControlRecord<T>[];
  }
  async record<T>(kind: string, id: string) {
    return structuredClone(this.control.get(`${kind}/${id}`)) as ControlRecord<T> | undefined;
  }
  async createRecord<T>(row: ControlRecord<T>) {
    const key = `${row.kind}/${row.id}`;
    if (this.control.has(key)) throw { code: 409 };
    const created = { ...row, version: "1" };
    this.control.set(key, created);
    return structuredClone(created);
  }
  async updateRecord<T>(row: ControlRecord<T>) {
    const key = `${row.kind}/${row.id}`;
    if (this.control.get(key)?.version !== row.version) throw { code: 409 };
    const updated = { ...row, version: String(Number(row.version) + 1) };
    this.control.set(key, updated);
    return structuredClone(updated);
  }
  async deleteRecord(row: ControlRecord) {
    const key = `${row.kind}/${row.id}`;
    if (this.control.get(key)?.version !== row.version) throw { code: 409 };
    this.control.delete(key);
  }
  override async create(input: Parameters<MemoryStore["create"]>[0]) {
    if (input.kind !== "Pod" || !input.spec || !("containers" in input.spec))
      throw new Error("Only an inspection Pod is expected");
    input.status = {
      phase: "Succeeded",
      containerStatuses: [
        {
          name: "inspect",
          ready: false,
          restartCount: 0,
          image: "workspace:default",
          imageID: "fixture",
          state: { terminated: { exitCode: 0, message: JSON.stringify(this.result) } },
        },
      ],
    };
    this.createdPods.push(structuredClone(input));
    return super.create(input);
  }
}

describe("Project ref inspection", () => {
  it("uses a Project-owned bounded Git Pod and removes it after a sanitized result", async () => {
    const store = new FinishedRefStore();
    const row = project();
    row.metadata.uid = "project-uid";
    row.spec.runtime = { image: "workspace:project" };
    const inspector = new ProjectRefInspector({ store, runtime });
    const result = await inspector.query({
      project: row,
      profile,
      query: { mode: "suggest", query: "feat", limit: 20 },
    });
    expect(result).toEqual({ mode: "suggest", refs: ["feature/new", "main"] });
    expect(store.objects.size).toBe(0);
    expect(store.control.size).toBe(0);
    expect(store.deletions).toHaveLength(1);
    const created = store.writes;
    expect(created).toBe(1);
    const pod = store.createdPods[0];
    if (!pod?.spec || !("containers" in pod.spec)) throw new Error("Expected Pod");
    expect(pod.metadata?.ownerReferences).toMatchObject([
      { kind: "PaseoProject", uid: "project-uid" },
    ]);
    expect(pod.metadata?.labels).toMatchObject({
      "app.kubernetes.io/managed-by": "paseo-kubernetes",
      "app.kubernetes.io/component": "workspace",
      "paseo-gateway.manziman.github.io/credential-profile": "claude-default",
    });
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.restartPolicy).toBe("Never");
    expect(pod.spec.containers[0]?.image).toBe("workspace:project");
    expect(pod.spec.containers[0]?.command).toEqual(["node", "/opt/paseo/inspect-refs.mjs"]);
  });

  it("projects only Git token or SSH credentials into the disposable Pod", async () => {
    const store = new FinishedRefStore();
    store.result = { version: 1, valid: true, exists: false };
    const row = project();
    row.metadata.uid = "project-uid";
    const tokenProfile: CredentialProfile = {
      ...profile,
      spec: {
        ...profile.spec,
        env: [
          {
            name: "PRIVATE_PROVIDER_TOKEN",
            valueFrom: { secretKeyRef: { name: "provider", key: "token" } },
          },
        ],
        git: { username: "x-access-token", tokenSecretRef: { name: "git-token", key: "token" } },
      },
    };
    const inspector = new ProjectRefInspector({ store, runtime });
    await inspector.query({
      project: row,
      profile: tokenProfile,
      query: { mode: "validate", branchName: "feature/new" },
    });
    const pod = store.createdPods[0];
    if (!pod?.spec || !("containers" in pod.spec)) throw new Error("Expected Pod");
    const container = pod.spec.containers[0];
    if (!container) throw new Error("Expected inspection container");
    expect(container.env?.some((item) => item.name === "PASEO_GIT_TOKEN_FILE")).toBe(true);
    expect(container.env?.some((item) => item.name === "PRIVATE_PROVIDER_TOKEN")).toBe(false);
    expect(pod.spec.volumes?.some((item) => item.name === "git-token")).toBe(true);

    const sshStore = new FinishedRefStore();
    sshStore.result = { version: 1, valid: true, exists: false };
    row.spec.repository = "git@example.test:owner/repo.git";
    const sshProfile: CredentialProfile = {
      ...profile,
      spec: {
        ...profile.spec,
        git: {
          username: "git",
          ssh: {
            keySecretRef: { name: "git-ssh", key: "key" },
            knownHostsRef: { configMapKeyRef: { name: "hosts", key: "known_hosts" } },
          },
        },
      },
    };
    await new ProjectRefInspector({ store: sshStore, runtime }).query({
      project: row,
      profile: sshProfile,
      query: { mode: "validate", branchName: "feature/new" },
    });
    const sshPod = sshStore.createdPods[0];
    if (!sshPod?.spec || !("containers" in sshPod.spec)) throw new Error("Expected SSH Pod");
    expect(sshPod.spec.containers[0]?.env?.some((item) => item.name === "GIT_SSH_COMMAND")).toBe(
      true,
    );
    expect(sshPod.spec.volumes?.some((item) => item.name === "git-ssh")).toBe(true);
  });

  it("fails closed when the termination message is truncated or contains diagnostics", async () => {
    const store = new FinishedRefStore();
    const row = project();
    row.metadata.uid = "project-uid";
    const inspector = new ProjectRefInspector({ store, runtime });
    store.result = { version: 1, refs: ["x".repeat(4_000)] };
    await expect(
      inspector.query({ project: row, profile, query: { mode: "suggest" } }),
    ).rejects.toThrow("retry shortly");
    expect(store.objects.size).toBe(0);
    expect(store.control.size).toBe(0);
    store.result = { version: 1, error: "private transport details" };
    await expect(
      inspector.query({ project: row, profile, query: { mode: "suggest" } }),
    ).rejects.toThrow("retry shortly");
    expect(store.objects.size).toBe(0);
    expect(store.control.size).toBe(0);
  });

  it("defers missing-UID create acknowledgment cleanup until expired recovery", async () => {
    const store = new FinishedRefStore();
    const row = project();
    row.metadata.uid = "project-uid";
    const create = store.create.bind(store);
    store.create = async (input) => {
      await create(input);
      throw new Error("private Kubernetes diagnostic");
    };
    const inspector = new ProjectRefInspector({ store, runtime });
    await expect(
      inspector.query({ project: row, profile, query: { mode: "suggest" } }),
    ).rejects.toThrow("cleanup is incomplete");
    expect(store.objects.size).toBe(1);
    expect(store.control.size).toBe(1);
    const replacementGateway = new ProjectRefInspector({
      store,
      runtime,
      now: () => Date.now() + 91_000,
    });
    await replacementGateway.recoverExpired();
    expect(store.objects.size).toBe(0);
    expect(store.deletions).toHaveLength(1);
    expect(store.control.size).toBe(0);
  });

  it("uses the locally acknowledged Pod UID if the durable UID update fails", async () => {
    const store = new FinishedRefStore();
    const row = project();
    row.metadata.uid = "project-uid";
    store.updateRecord = async () => {
      const pod = [...store.objects.values()].find((entry) => entry.kind === "Pod");
      if (!pod?.metadata) throw new Error("Expected created Pod");
      pod.metadata.uid = "replacement-uid";
      throw { code: 409 };
    };
    const inspector = new ProjectRefInspector({ store, runtime });
    await expect(
      inspector.query({ project: row, profile, query: { mode: "suggest" } }),
    ).rejects.toThrow("cleanup is incomplete");
    expect(store.objects.size).toBe(1);
    expect(store.control.size).toBe(1);
    expect(store.deletions).toEqual([]);
  });

  it("cleans the acknowledged Pod even when its UID receipt update is lost", async () => {
    const store = new FinishedRefStore();
    const row = project();
    row.metadata.uid = "project-uid";
    store.updateRecord = async () => {
      throw new Error("lost UID receipt update");
    };
    const inspector = new ProjectRefInspector({ store, runtime });
    await expect(
      inspector.query({ project: row, profile, query: { mode: "suggest" } }),
    ).rejects.toThrow("retry shortly");
    expect(store.objects.size).toBe(0);
    expect(store.control.size).toBe(0);
    expect(store.deletions).toHaveLength(1);
  });
});

function orphan(
  store: FinishedRefStore,
  input: {
    runId: string;
    projectUid?: string;
    podUid?: string;
    receiptUid?: string;
    startedAt: string;
  },
) {
  const projectUid = input.projectUid ?? "project-uid";
  const name = `refs-${input.runId.replace(/-/g, "").slice(0, 24)}`;
  const pod: V1Pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: "test",
      uid: input.podUid ?? "owned-pod-uid",
      labels: { "paseo-gateway.manziman.github.io/ref-inspection-run": input.runId },
      ownerReferences: [
        { apiVersion: API_VERSION, kind: "PaseoProject", name: "example", uid: projectUid },
      ],
    },
    spec: { containers: [{ name: "inspect", image: "workspace:default" }] },
  };
  store.objects.set(`Pod/${name}`, pod);
  store.control.set(`project-ref-inspection/${input.runId}`, {
    kind: "project-ref-inspection",
    id: input.runId,
    version: "1",
    value: {
      runId: input.runId,
      name,
      projectUid,
      startedAt: input.startedAt,
      ...(input.receiptUid ? { podUid: input.receiptUid } : {}),
    },
  });
  return name;
}

describe("Project ref orphan recovery", () => {
  const runId = "11111111-2222-4333-8444-555555555555";
  const startedAt = "2026-01-01T00:00:00.000Z";

  it("reclaims a stale Pod with a missing create UID receipt after gateway restart", async () => {
    const store = new FinishedRefStore();
    const name = orphan(store, { runId, startedAt });
    const replacementGateway = new ProjectRefInspector({
      store,
      runtime,
      now: () => Date.parse(startedAt) + 91_000,
    });
    await replacementGateway.recoverExpired();
    expect(store.objects.has(`Pod/${name}`)).toBe(false);
    expect(store.control.size).toBe(0);
    expect(store.deletions).toEqual([name]);
  });

  it("leaves an unexpired active run and a replaced Pod UID untouched", async () => {
    const store = new FinishedRefStore();
    const name = orphan(store, {
      runId,
      startedAt,
      podUid: "replacement-uid",
      receiptUid: "original-uid",
    });
    const activeGateway = new ProjectRefInspector({
      store,
      runtime,
      now: () => Date.parse(startedAt) + 50_000,
    });
    await activeGateway.recoverExpired();
    expect(store.deletions).toEqual([]);
    const nextGateway = new ProjectRefInspector({
      store,
      runtime,
      now: () => Date.parse(startedAt) + 91_000,
    });
    await expect(nextGateway.recoverExpired()).rejects.toThrow("incomplete");
    expect(store.objects.has(`Pod/${name}`)).toBe(true);
    expect(store.control.size).toBe(1);
    expect(store.deletions).toEqual([]);
  });

  it("never deletes a Pod whose Project owner UID changed", async () => {
    const store = new FinishedRefStore();
    const name = orphan(store, { runId, startedAt, receiptUid: "owned-pod-uid" });
    const pod = store.objects.get(`Pod/${name}`);
    if (!pod?.metadata?.ownerReferences?.[0]) throw new Error("Expected orphan fixture Pod");
    pod.metadata.ownerReferences[0].uid = "replacement-project-uid";
    const replacementGateway = new ProjectRefInspector({
      store,
      runtime,
      now: () => Date.parse(startedAt) + 91_000,
    });
    await expect(replacementGateway.recoverExpired()).rejects.toThrow("incomplete");
    expect(store.objects.has(`Pod/${name}`)).toBe(true);
    expect(store.control.size).toBe(1);
    expect(store.deletions).toEqual([]);
  });
});

function sessionFixture() {
  const store = new MemoryStore();
  const row = store.projectRows[0];
  if (!row) throw new Error("Expected configured Project");
  row.metadata.uid = "project-uid";
  store.profileRows.set(profile.metadata.name, profile);
  const emitted: unknown[] = [];
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let wait: Promise<void> | undefined;
  const session = new GatewaySession({
    store,
    namespace: "test",
    backendPassword: "backend",
    directory: new DirectoryGeneration(),
    hello: { type: "hello", clientId: "fixture", clientType: "cli", protocolVersion: 1 },
    emit(message) {
      emitted.push(SessionOutboundMessageSchema.parse(message));
    },
    emitBinary() {},
    disconnect() {},
    providerCatalog: {
      async identity(current) {
        return { fingerprint: JSON.stringify(current.spec) };
      },
      async snapshot() {
        return [];
      },
      async checkoutStatus() {
        throw new Error("not needed");
      },
      watch() {
        return () => {};
      },
    },
    projectRefs: {
      async query(input) {
        entered?.();
        await wait;
        return input.query.mode === "suggest"
          ? { mode: "suggest", refs: ["feature/new", "main"] }
          : { mode: "validate", valid: true, exists: true };
      },
    },
  });
  return {
    store,
    session,
    emitted,
    hold() {
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      return { started, release: () => release?.() };
    },
  };
}

describe("project-scoped ref RPC", () => {
  it("returns remote branch provenance and the pinned validation response", async () => {
    const fixture = sessionFixture();
    await fixture.session.handle({
      type: "branch_suggestions_request",
      requestId: "suggest",
      cwd: "/projects/example",
      query: "feat",
      limit: 20,
    });
    await fixture.session.handle({
      type: "validate_branch_request",
      requestId: "validate",
      cwd: "/projects/example",
      branchName: "feature/new",
    });
    expect(fixture.emitted).toMatchObject([
      {
        type: "branch_suggestions_response",
        payload: {
          requestId: "suggest",
          branches: ["feature/new", "main"],
          branchDetails: [
            { name: "feature/new", hasLocal: false, hasRemote: true },
            { name: "main", hasLocal: false, hasRemote: true },
          ],
        },
      },
      {
        type: "validate_branch_response",
        payload: {
          requestId: "validate",
          exists: true,
          resolvedRef: "origin/feature/new",
          isRemote: true,
          error: null,
        },
      },
    ]);
    await fixture.session.close();
  });

  it("rejects unknown projects and profile changes while inspection is awaited", async () => {
    const fixture = sessionFixture();
    await fixture.session.handle({
      type: "branch_suggestions_request",
      requestId: "unknown",
      cwd: "/projects/other",
    });
    const gate = fixture.hold();
    const pending = fixture.session.handle({
      type: "branch_suggestions_request",
      requestId: "race",
      cwd: "/projects/example",
    });
    await gate.started;
    const row = fixture.store.projectRows[0];
    if (!row) throw new Error("Expected configured Project");
    row.spec.credentialProfile = "changed";
    gate.release();
    await pending;
    expect(fixture.emitted).toMatchObject([
      { type: "rpc_error", payload: { requestId: "unknown" } },
      { type: "rpc_error", payload: { requestId: "race" } },
    ]);
    expect(JSON.stringify(fixture.emitted)).not.toContain("feature/new");
    await fixture.session.close();
  });

  it("rejects a same-name Project replacement before exposing inspected refs", async () => {
    const fixture = sessionFixture();
    const gate = fixture.hold();
    const pending = fixture.session.handle({
      type: "branch_suggestions_request",
      requestId: "replaced",
      cwd: "/projects/example",
    });
    await gate.started;
    const row = fixture.store.projectRows[0];
    if (!row) throw new Error("Expected configured Project");
    row.metadata.uid = "replacement-uid";
    gate.release();
    await pending;
    expect(fixture.emitted).toMatchObject([
      { type: "rpc_error", payload: { requestId: "replaced" } },
    ]);
    expect(JSON.stringify(fixture.emitted)).not.toContain("feature/new");
    await fixture.session.close();
  });
});
