import { describe, expect, it } from "vitest";
import { parseScopedId, scopedId } from "../src/domain.js";
import { DirectoryGeneration } from "../src/gateway/catalog.js";
import { selectWorkspace, TerminalSlots, translate } from "../src/gateway/routing.js";
import { workspace } from "./fixtures.js";

describe("routing", () => {
  it("reversibly scopes backend IDs without a database", () => {
    const id = "provider/agent:with spaces~✓";
    expect(parseScopedId(scopedId("one", id))).toEqual({ workspaceId: "one", backendId: id });
    expect(scopedId("one", id)).not.toBe(scopedId("two", id));
    expect(() => parseScopedId("one~a")).toThrow();
  });
  it("rejects conflicting workspace and agent routes", () => {
    expect(() =>
      selectWorkspace({ workspaceId: "one", agentId: scopedId("two", "x") }, [
        workspace("one"),
        workspace("two"),
      ]),
    ).toThrow("single workspace");
  });
  it("does not route path traversal or similar prefixes into a workspace", () => {
    expect(() => selectWorkspace({ cwd: "/workspaces/one/../../etc" }, [workspace()])).toThrow();
    expect(() => selectWorkspace({ cwd: "/workspaces/one-more" }, [workspace()])).toThrow();
  });
  it("preserves arbitrary user content while translating routing metadata", () => {
    const value = {
      agentId: "abc",
      event: { content: { agentId: "do not rewrite" } },
      agent: { id: "abc", provider: "claude" },
    };
    const result = translate(value, workspace(), "local", "out");
    expect(result).toEqual({
      ...value,
      agentId: scopedId("one", "abc"),
      agent: { id: scopedId("one", "abc"), provider: "claude" },
    });
  });
  it("preserves permission request IDs in fetched agent snapshots", () => {
    const permission = {
      id: "permission-1",
      provider: "claude",
      name: "Bash",
      kind: "tool",
      input: { command: "sleep 60" },
    };
    const result = translate(
      { agent: { id: "agent-1", provider: "claude", pendingPermissions: [permission] } },
      workspace(),
      "local",
      "out",
    );
    expect(result).toEqual({
      agent: {
        id: scopedId("one", "agent-1"),
        provider: "claude",
        pendingPermissions: [permission],
      },
    });
  });
  it("keeps identical terminal slots on separate backends distinct", () => {
    const slots = new TerminalSlots();
    const a = slots.outward("one", 1);
    const b = slots.outward("two", 1);
    expect(a).not.toBe(b);
    expect(slots.inward(a)).toEqual({ workspaceId: "one", backendSlot: 1 });
    expect(slots.outward("one", 1)).toBe(a);
  });
  it("starts a new authoritative snapshot generation after replacement", () => {
    const previous = new DirectoryGeneration();
    const current = new DirectoryGeneration();
    expect(current.snapshot(previous.id)).toMatchObject({
      mode: "snapshot",
      reason: "generation_changed",
      removals: [],
    });
    expect(current.id).not.toBe(previous.id);
  });
});
