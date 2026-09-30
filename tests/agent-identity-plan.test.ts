import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { ScheduleTargetSchema } from "@getpaseo/protocol/schedule/types";
import { describe, expect, it, vi } from "vitest";
import { scopedId } from "../src/domain.js";
import { AgentIdentityRegistry } from "../src/gateway/agent-identity.js";
import { AgentRouting } from "../src/gateway/agent-routing.js";
import { translate } from "../src/gateway/routing.js";
import { workspace } from "./fixtures.js";
import { MemoryRecordStore } from "./record-store.js";

const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("GUID agent identity prototype", () => {
  it("matches the pinned desktop schedule lookup and survives gateway recreation", async () => {
    const records = new MemoryRecordStore();
    const row = workspace("one");
    const first = new AgentIdentityRegistry(records);
    const publicId = await first.claim(row, nativeId);
    const target = ScheduleTargetSchema.parse({ type: "agent", agentId: nativeId });
    expect(target).toMatchObject({ type: "agent", agentId: publicId });
    const restarted = new AgentIdentityRegistry(records);
    expect(await restarted.resolve(publicId, [row])).toMatchObject({
      workspace: row,
      backendAgentId: nativeId,
    });
    expect(await restarted.resolve(scopedId(row.metadata.name, nativeId), [row])).toMatchObject({
      workspace: row,
      backendAgentId: nativeId,
    });
  });

  it("rejects colliding native GUIDs, replaced UIDs, and unauthorized routes", async () => {
    const records = new MemoryRecordStore();
    const registry = new AgentIdentityRegistry(records);
    const first = workspace("one");
    const second = workspace("two");
    await registry.claim(first, nativeId);
    await expect(registry.resolve(nativeId, [second])).rejects.toThrow("access was revoked");
    const replacement = { ...first, metadata: { ...first.metadata, uid: "replacement-uid" } };
    await expect(registry.resolve(nativeId, [replacement])).rejects.toThrow("UID changed");
    await expect(registry.claim(second, nativeId)).rejects.toThrow("already bound");
    await expect(registry.resolve(nativeId, [first])).rejects.toThrow("quarantined");
    await expect(new AgentIdentityRegistry(records).resolve(nativeId, [first])).rejects.toThrow(
      "quarantined",
    );
    await expect(registry.claim(replacement, nativeId)).rejects.toThrow("quarantined");
  });

  it("does not bind an unknown old scoped ID to a reused workspace name", async () => {
    const registry = new AgentIdentityRegistry(new MemoryRecordStore());
    await expect(registry.resolve(scopedId("one", nativeId), [workspace("one")])).rejects.toThrow();
  });

  it("rejects malformed route records and mismatched keys", async () => {
    const records = new MemoryRecordStore();
    await records.createRecord({
      kind: "agent-route",
      id: nativeId,
      value: {
        state: "active",
        workspaceId: "one",
        workspaceUid: "original-uid",
        backendAgentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    });
    await expect(
      new AgentIdentityRegistry(records).resolve(nativeId, [workspace("one")]),
    ).rejects.toThrow("key and backend ID differ");
  });

  it("caches a confirmed claim for streamed updates but reads fresh on resolve", async () => {
    const records = new MemoryRecordStore();
    const registry = new AgentIdentityRegistry(records);
    const row = workspace("one");
    await registry.claim(row, nativeId);
    const create = vi.spyOn(records, "createRecord");
    await registry.claim(row, nativeId);
    expect(create).not.toHaveBeenCalled();
    const read = vi.spyOn(records, "record");
    await registry.resolve(nativeId, [row]);
    expect(read).toHaveBeenCalled();
  });

  it("suppresses a cached outward identity quarantined by another registry", async () => {
    const records = new MemoryRecordStore();
    const first = new AgentRouting(new AgentIdentityRegistry(records));
    const second = new AgentIdentityRegistry(records);
    await expect(
      first.project({ agent: { id: scopedId("one", nativeId) } }, workspace("one")),
    ).resolves.toEqual({ agent: { id: nativeId } });
    await expect(second.claim(workspace("two"), nativeId)).rejects.toThrow("already bound");
    await expect(
      first.project({ agent: { id: scopedId("one", nativeId) } }, workspace("one")),
    ).rejects.toThrow("quarantined");
  });

  it("leaves pinned provider model IDs unchanged", async () => {
    const row = workspace("one");
    const reply = SessionOutboundMessageSchema.parse({
      type: "get_providers_snapshot_response",
      payload: {
        requestId: "models",
        generatedAt: new Date().toISOString(),
        entries: [
          {
            provider: "codex",
            status: "ready",
            enabled: true,
            models: [
              {
                provider: "codex",
                id: "gpt-5.3-codex",
                label: "Codex",
                metadata: { agentId: "provider-local-key" },
              },
            ],
          },
        ],
      },
    });
    const translated = translate(reply, row, "local", "out");
    const projected = await new AgentRouting(
      new AgentIdentityRegistry(new MemoryRecordStore()),
    ).project(translated, row);
    expect(SessionOutboundMessageSchema.parse(projected)).toEqual(reply);
  });

  it("normalizes only the reserved legacy parent label for desktop association", async () => {
    const parentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const records = new MemoryRecordStore();
    const routing = new AgentRouting(new AgentIdentityRegistry(records));
    const projected = await routing.project(
      {
        agent: {
          id: scopedId("one", nativeId),
          labels: {
            "paseo.parent-agent-id": scopedId("outside-scope", parentId),
            custom: scopedId("outside-scope", parentId),
          },
        },
      },
      workspace("one"),
    );
    expect(projected).toEqual({
      agent: {
        id: nativeId,
        labels: {
          "paseo.parent-agent-id": parentId,
          custom: scopedId("outside-scope", parentId),
        },
      },
    });
    expect(await records.record("agent-route", parentId)).toBeUndefined();
  });
});
