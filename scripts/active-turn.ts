import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { workspacePath } from "../src/domain.js";

/** A bounded text response keeps the provider busy without tool permissions or background jobs. */
export async function startActiveTurn(client: DaemonClient, workspaceId: string) {
  const marker = `PASEO_ACTIVE_OK_${workspaceId}`;
  const agent = await client.createAgent({
    config: { provider: "claude", cwd: workspacePath(workspaceId) },
    workspaceId,
    initialPrompt: `This is a streaming recovery test. Write exactly 120 numbered lines. Each line should be a distinct sentence of 20 to 25 words describing an everyday object. Do not use tools, summarize, skip lines, or ask questions. After line 120, put ${marker} alone on the final line.`,
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    const snapshot = await client.fetchAgent(agent.id);
    assert.ok(snapshot, "Active-turn agent must remain discoverable");
    assert.notEqual(snapshot.agent.status, "error", "Active-turn provider failed");
    assert.equal(
      snapshot.agent.pendingPermissions.length,
      0,
      "This test must not wait on permission",
    );
    if (snapshot.agent.status === "running" && snapshot.agent.activeTurn?.turnId) {
      console.log("Observed an active Claude text-generation turn before gateway replacement.");
      return { id: agent.id, marker, turnId: snapshot.agent.activeTurn.turnId };
    }
    await delay(1000);
  }
  throw new Error("Did not observe an active Claude turn");
}

/** Require the same live turn after reconnect, then completion without replaying the prompt. */
export async function verifyActiveTurn(
  client: DaemonClient,
  turn: Awaited<ReturnType<typeof startActiveTurn>>,
) {
  const snapshot = await client.fetchAgent(turn.id);
  assert.ok(snapshot);
  assert.equal(snapshot.agent.status, "running", "Reconnect must occur while the turn still runs");
  assert.equal(snapshot.agent.activeTurn?.turnId, turn.turnId);
  assert.equal(snapshot.agent.pendingPermissions.length, 0);
  const finished = await client.waitForFinish(turn.id, 180000);
  assert.equal(finished.status, "idle", "The original turn must complete without another prompt");
  const timeline = await client.fetchAgentTimeline(turn.id);
  assert.equal(timeline.error, null);
  assert.equal(
    timeline.entries.filter(
      ({ item }) => item.type === "user_message" && item.text.includes(turn.marker),
    ).length,
    1,
    "The original prompt must occur exactly once",
  );
  assert.ok(!timeline.entries.some(({ item }) => item.type === "tool_call"));
  assert.ok(
    timeline.entries.some(
      ({ item }) => item.type === "assistant_message" && item.text.trim().endsWith(turn.marker),
    ),
  );
  console.log(
    "PASS: the same active Claude turn survives gateway replacement and finishes with one original prompt.",
  );
}
