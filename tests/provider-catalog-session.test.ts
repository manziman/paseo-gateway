import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { DirectoryGeneration } from "../src/gateway/catalog.js";
import { GatewaySession } from "../src/gateway/session.js";
import { MemoryStore } from "./fixtures.js";

const ready: ProviderSnapshotEntry[] = [
  { provider: "claude", status: "ready", enabled: true, models: [] },
];

function setup() {
  const store = new MemoryStore();
  const configuredProject = store.projectRows[0];
  if (!configuredProject) throw new Error("Test project is unavailable");
  configuredProject.metadata.uid = "project-uid";
  const emitted: unknown[] = [];
  let entries: ProviderSnapshotEntry[] = [];
  let update: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  let identityGate: { onCall: number; wait: Promise<void>; entered: () => void } | undefined;
  let identityCalls = 0;
  const seen: string[] = [];
  const session = new GatewaySession({
    store,
    namespace: "test",
    backendPassword: "backend",
    directory: new DirectoryGeneration(),
    hello: { type: "hello", clientId: "test", clientType: "cli", protocolVersion: 1 },
    emit: (message) => emitted.push(SessionOutboundMessageSchema.parse(message)),
    emitBinary() {},
    disconnect() {},
    providerCatalog: {
      async identity(project) {
        identityCalls++;
        if (identityGate?.onCall === identityCalls) {
          identityGate.entered();
          await identityGate.wait;
        }
        return { fingerprint: JSON.stringify(project.spec) };
      },
      async snapshot(project, force) {
        const pending = gate;
        gate = undefined;
        await pending;
        seen.push(`${project.metadata.name}:${force ? "refresh" : "get"}`);
        return entries;
      },
      watch(_projectId, callback) {
        update = () => callback(entries);
        return () => {
          update = undefined;
        };
      },
    },
  });
  return {
    store,
    emitted,
    seen,
    session,
    setEntries(value: ProviderSnapshotEntry[]) {
      entries = value;
      update?.();
    },
    holdNextSnapshot() {
      let release: (() => void) | undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release?.();
    },
    holdIdentityCall(onCall: number) {
      let release: (() => void) | undefined;
      let entered: (() => void) | undefined;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      identityGate = { onCall, wait, entered: () => entered?.() };
      return { entered: enteredPromise, release: () => release?.() };
    },
  };
}

async function nextTurn() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("project-scoped provider discovery", () => {
  it("acknowledges an empty cold snapshot, then publishes verified catalog at the project cwd", async () => {
    const fixture = setup();
    await fixture.session.handle({
      type: "get_providers_snapshot_request",
      requestId: "get",
      cwd: "/projects/example",
    });
    await fixture.session.handle({
      type: "refresh_providers_snapshot_request",
      requestId: "refresh",
      cwd: "/projects/example",
    });
    expect(fixture.emitted).toMatchObject([
      {
        type: "get_providers_snapshot_response",
        payload: { requestId: "get", cwd: "/projects/example", entries: [] },
      },
      {
        type: "refresh_providers_snapshot_response",
        payload: { requestId: "refresh", acknowledged: true },
      },
    ]);
    fixture.setEntries(ready);
    await nextTurn();
    expect(fixture.emitted.at(-1)).toMatchObject({
      type: "providers_snapshot_update",
      payload: { cwd: "/projects/example", entries: ready },
    });
    expect(fixture.seen).toEqual(["example:get", "example:refresh", "example:get"]);
    await fixture.session.close();
  });

  it("rejects unknown project scopes and stops updates after session close", async () => {
    const fixture = setup();
    await fixture.session.handle({
      type: "get_providers_snapshot_request",
      requestId: "unknown",
      cwd: "/projects/other",
    });
    expect(fixture.emitted).toMatchObject([
      { type: "rpc_error", payload: { requestId: "unknown" } },
    ]);
    await fixture.session.handle({
      type: "get_providers_snapshot_request",
      requestId: "known",
      cwd: "/projects/example",
    });
    await fixture.session.close();
    const count = fixture.emitted.length;
    fixture.setEntries(ready);
    await nextTurn();
    expect(fixture.emitted).toHaveLength(count);
  });

  it("drops a catalog if the Project profile changes while a snapshot is awaited", async () => {
    const fixture = setup();
    fixture.setEntries(ready);
    const release = fixture.holdNextSnapshot();
    const request = fixture.session.handle({
      type: "get_providers_snapshot_request",
      requestId: "race",
      cwd: "/projects/example",
    });
    await nextTurn();
    const row = fixture.store.projectRows[0];
    if (!row) throw new Error("Test project is unavailable");
    row.spec.credentialProfile = "changed-profile";
    release();
    await request;
    expect(fixture.emitted).toMatchObject([{ type: "rpc_error", payload: { requestId: "race" } }]);
    expect(JSON.stringify(fixture.emitted)).not.toContain('"models"');
    await fixture.session.close();
  });

  it("rechecks access after the final credential identity read", async () => {
    const fixture = setup();
    fixture.setEntries(ready);
    const gate = fixture.holdIdentityCall(2);
    const request = fixture.session.handle({
      type: "get_providers_snapshot_request",
      requestId: "final-fence",
      cwd: "/projects/example",
    });
    await gate.entered;
    const row = fixture.store.projectRows[0];
    if (!row) throw new Error("Test project is unavailable");
    row.spec.credentialProfile = "revoked-profile";
    gate.release();
    await request;
    expect(fixture.emitted).toMatchObject([
      { type: "rpc_error", payload: { requestId: "final-fence" } },
    ]);
    expect(JSON.stringify(fixture.emitted)).not.toContain('"models"');
    await fixture.session.close();
  });
});
