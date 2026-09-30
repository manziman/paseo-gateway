import { randomUUID } from "node:crypto";
import {
  FetchAgentTimelineResponseMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { Workspace } from "../domain.js";
import type { RecordStore } from "../kubernetes/records.js";
import type { Backend } from "./backend.js";

const MAX_AGENTS = 100;
const MAX_AGENT_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 50;
const MAX_ENTRIES = 1000;
const CAPTURE_TIMEOUT_MS = 60000;

async function withinCaptureDeadline<T>(run: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Retained history capture deadline exceeded");
  const operation = run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Retained history capture deadline exceeded")),
          remaining,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TimelineResponse = FetchAgentTimelineResponseMessageSchema;
type TimelinePayload = z.infer<typeof TimelineResponse>["payload"];
export type RetainedTimelineEntry = TimelinePayload["entries"][number];

export const RetainedAgentHistorySchema = z.object({
  epoch: z.string(),
  window: TimelineResponse.shape.payload.shape.window,
  entries: TimelineResponse.shape.payload.shape.entries,
  truncated: z.boolean(),
});
export const RetainedHistorySnapshotSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string(),
  workspaceUid: z.string(),
  workspaceGeneration: z.number().int().nonnegative(),
  capturedAt: z.string(),
  agents: z.record(z.string(), RetainedAgentHistorySchema),
});
export type RetainedHistorySnapshot = z.infer<typeof RetainedHistorySnapshotSchema>;
export type RetainedAgentHistory = RetainedHistorySnapshot["agents"][string];
const RECEIPT_KIND = "retained-history";
const ReceiptSchema = z.object({
  workspaceId: z.string(),
  workspaceUid: z.string(),
  workspaceGeneration: z.number().int().nonnegative(),
  capturedAt: z.string(),
  fileName: z.string().regex(/^[a-f0-9-]+\.json$/i),
});
export type RetainedHistoryReceipt = z.infer<typeof ReceiptSchema>;

/** A metadata-only CAS publication; no timeline item enters the API server. */
export async function publishRetainedHistoryReceipt(
  records: RecordStore,
  snapshot: RetainedHistorySnapshot,
  fileName: string,
): Promise<RetainedHistoryReceipt> {
  const value = ReceiptSchema.parse({
    workspaceId: snapshot.workspaceId,
    workspaceUid: snapshot.workspaceUid,
    workspaceGeneration: snapshot.workspaceGeneration,
    capturedAt: snapshot.capturedAt,
    fileName,
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await records.record<RetainedHistoryReceipt>(
      RECEIPT_KIND,
      snapshot.workspaceUid,
    );
    if (previous) {
      const current = ReceiptSchema.parse(previous.value);
      if (
        current.workspaceUid !== snapshot.workspaceUid ||
        current.workspaceId !== snapshot.workspaceId
      )
        throw new Error("Retained history receipt identity changed");
      if (
        current.workspaceGeneration > value.workspaceGeneration ||
        (current.workspaceGeneration === value.workspaceGeneration &&
          current.capturedAt >= value.capturedAt)
      )
        return current;
    }
    try {
      if (previous)
        await records.updateRecord({
          kind: RECEIPT_KIND,
          id: snapshot.workspaceUid,
          version: previous.version,
          value,
        });
      else await records.createRecord({ kind: RECEIPT_KIND, id: snapshot.workspaceUid, value });
      return value;
    } catch (error) {
      if (
        attempt === 3 ||
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== 409
      )
        throw error;
    }
  }
  throw new Error("Retained history receipt publication exhausted retries");
}

export async function latestRetainedHistoryReceipt(
  records: RecordStore,
  workspace: Workspace,
): Promise<RetainedHistoryReceipt | undefined> {
  const uid = workspace.metadata.uid;
  if (!uid) return undefined;
  const record = await records.record<unknown>(RECEIPT_KIND, uid);
  if (!record) return undefined;
  const receipt = ReceiptSchema.parse(record.value);
  const prefix = `${uid}-${receipt.workspaceGeneration}-`;
  if (
    receipt.workspaceId !== workspace.metadata.name ||
    receipt.workspaceUid !== uid ||
    !receipt.fileName.startsWith(prefix) ||
    !/^\d{13}-[a-f0-9-]+\.json$/.test(receipt.fileName.slice(prefix.length))
  )
    return undefined;
  return receipt;
}

export async function readRetainedHistoryReceipt(
  records: RecordStore,
  workspace: Workspace,
): Promise<RetainedHistoryReceipt | undefined> {
  const receipt = await latestRetainedHistoryReceipt(records, workspace);
  return receipt?.workspaceGeneration === workspace.metadata.generation ? receipt : undefined;
}

/** No provider process is started here: read from the already-running native daemon. */
export async function captureRetainedHistory(
  backend: Backend,
  workspace: Workspace,
  expectedGeneration = workspace.metadata.generation ?? 1,
): Promise<RetainedHistorySnapshot> {
  const uid = workspace.metadata.uid;
  if (!uid) throw new Error("Workspace UID required for retained history");
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  const agents: RetainedHistorySnapshot["agents"] = Object.create(null);
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let count = 0;
  let budgetExhausted = false;
  do {
    let listed: SessionOutboundMessage;
    try {
      listed = await withinCaptureDeadline(
        () =>
          backend.request({
            type: "fetch_agents_request",
            requestId: randomUUID(),
            filter: { includeArchived: true },
            page: { limit: 100, ...(cursor ? { cursor } : {}) },
          }),
        deadline,
      );
    } catch (error) {
      if (count > 0) break;
      throw error;
    }
    if (listed.type !== "fetch_agents_response")
      throw new Error("Unexpected retained history agent list");
    for (const { agent } of listed.payload.entries) {
      if (++count > MAX_AGENTS) {
        budgetExhausted = true;
        break;
      }
      const entries: RetainedTimelineEntry[] = [];
      let first: TimelinePayload | undefined;
      let before: TimelinePayload["startCursor"] = null;
      let truncated = false;
      const seenPages = new Set<string>();
      do {
        let response: SessionOutboundMessage;
        try {
          response = await withinCaptureDeadline(
            () =>
              backend.request({
                type: "fetch_agent_timeline_request",
                requestId: randomUUID(),
                agentId: agent.id,
                direction: before ? "before" : "tail",
                ...(before ? { cursor: before } : {}),
                projection: "projected",
                limit: PAGE_SIZE,
              }),
            deadline,
          );
          if (response.type !== "fetch_agent_timeline_response" || response.payload.error)
            throw new Error("Native retained history fetch failed");
        } catch (error) {
          if (!first) {
            if (Object.keys(agents).length === 0) throw error;
            budgetExhausted = Date.now() >= deadline;
            break;
          }
          entries.splice(0, entries.length, ...first.entries);
          truncated = true;
          break;
        }
        const page: TimelinePayload = (
          response as Extract<SessionOutboundMessage, { type: "fetch_agent_timeline_response" }>
        ).payload;
        const baseline = first ?? page;
        first = baseline;
        if (baseline.epoch !== page.epoch || baseline.window.nextSeq !== page.window.nextSeq) {
          entries.splice(0, entries.length, ...baseline.entries);
          truncated = true;
          break;
        }
        entries.unshift(...page.entries);
        const bytes = Buffer.byteLength(JSON.stringify(entries));
        if (bytes > MAX_AGENT_BYTES || entries.length > MAX_ENTRIES) {
          entries.splice(0, page.entries.length);
          truncated = true;
          break;
        }
        if (!page.hasOlder) break;
        if (!page.startCursor || !page.entries.length) {
          truncated = true;
          break;
        }
        const marker = `${page.startCursor.epoch}:${page.startCursor.seq}`;
        if (seenPages.has(marker)) {
          entries.splice(0, entries.length, ...baseline.entries);
          truncated = true;
          break;
        }
        seenPages.add(marker);
        before = page.startCursor;
      } while (!truncated);
      if (!first) {
        if (budgetExhausted) break;
        continue;
      }
      agents[agent.id] = { epoch: first.epoch, window: first.window, entries, truncated };
      if (Buffer.byteLength(JSON.stringify(agents)) > MAX_SNAPSHOT_BYTES - 65536) {
        delete agents[agent.id];
        budgetExhausted = true;
        break;
      }
    }
    if (budgetExhausted) break;
    cursor = listed.payload.pageInfo.hasMore
      ? (listed.payload.pageInfo.nextCursor ?? undefined)
      : undefined;
    if (cursor && seenCursors.has(cursor)) throw new Error("Agent list repeated a cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  const snapshot = RetainedHistorySnapshotSchema.parse({
    version: 1,
    workspaceId: workspace.metadata.name,
    workspaceUid: uid,
    workspaceGeneration: expectedGeneration,
    capturedAt: new Date().toISOString(),
    agents,
  });
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES)
    throw new Error("Retained history workspace snapshot exceeds budget");
  return snapshot;
}

type TimelineRequest = Extract<SessionInboundMessage, { type: "fetch_agent_timeline_request" }>;
/** Select a bounded, protocol-shaped page from a UID-checked immutable snapshot. */
export function retainedHistoryPage(
  request: TimelineRequest,
  agent: TimelinePayload["agent"],
  history: RetainedAgentHistory | undefined,
): Extract<SessionOutboundMessage, { type: "fetch_agent_timeline_response" }> {
  const direction = request.direction ?? "tail";
  const projection = request.projection ?? "projected";
  const error = !history
    ? "Workspace is stopped; transcript is unavailable because no retained snapshot exists for this agent"
    : projection !== "projected"
      ? "Canonical transcript projection is unavailable while compute is stopped"
      : history.truncated && history.entries.length === 0 && history.window.maxSeq > 0
        ? "Retained transcript exceeded its per-agent budget; no complete page was stored"
        : null;
  const epoch = history?.epoch ?? "";
  const window = history?.window ?? { minSeq: 0, maxSeq: 0, nextSeq: 0 };
  const rows = history?.entries ?? [];
  const minSaved = rows[0]?.seqStart ?? window.minSeq;
  const maxSaved = rows.at(-1)?.seqEnd ?? window.maxSeq;
  const staleCursor = !!request.cursor && request.cursor.epoch !== epoch;
  const afterGap =
    direction === "after" &&
    !!request.cursor &&
    !staleCursor &&
    !!history?.truncated &&
    request.cursor.seq < minSaved - 1;
  const reset = staleCursor || afterGap;
  const effectiveDirection = reset ? "tail" : direction;
  const limit = request.limit && request.limit > 0 ? Math.min(request.limit, 200) : 200;
  const selected =
    effectiveDirection === "tail"
      ? rows.slice(-limit)
      : effectiveDirection === "before"
        ? rows.filter((row) => row.seqEnd < (request.cursor?.seq ?? window.nextSeq)).slice(-limit)
        : rows.filter((row) => row.seqStart > (request.cursor?.seq ?? 0)).slice(0, limit);
  const first = selected[0];
  const last = selected.at(-1);
  const beforeGap =
    effectiveDirection === "before" &&
    !!request.cursor &&
    request.cursor.seq <= minSaved &&
    !!history?.truncated;
  const payload = {
    requestId: request.requestId,
    agentId: request.agentId,
    agent,
    direction,
    projection,
    epoch,
    reset,
    staleCursor,
    gap: beforeGap || afterGap,
    window,
    startCursor: first ? { epoch, seq: first.seqStart } : null,
    endCursor: last ? { epoch, seq: last.seqEnd } : null,
    hasOlder: !!first && (first.seqStart > minSaved || !!history?.truncated),
    hasNewer: !!last && last.seqEnd < maxSaved,
    entries: error ? [] : selected,
    error: error ?? (beforeGap ? "Earlier transcript pages were not retained" : null),
  };
  const parsed = SessionOutboundMessageSchema.parse({
    type: "fetch_agent_timeline_response",
    payload,
  });
  if (parsed.type !== "fetch_agent_timeline_response") throw new Error("Invalid retained timeline");
  return parsed;
}
