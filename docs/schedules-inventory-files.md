# Schedule, inventory, and file routing contracts

The gateway implements the pinned Paseo 0.9.1 client protocol without changing the client or daemon. These contracts are scoped to configured projects and credential profiles.

## Existing-agent schedules

An existing-agent schedule resolves the agent's exact ID in an authorized, ready workspace when the schedule is created or retargeted. The stored binding includes the workspace UID. Dispatch checks that binding, project, profile, schedule origin, and current readiness before sending a prompt. A suspended, archived, missing, replaced, or ambiguous target fails explicitly; resume a suspended workspace before scheduling or dispatching to it. The scheduler neither creates a replacement agent nor archives a reused workspace.

Each run has a reserved ID before dispatch. After a prompt may have been accepted, a lost response is recorded as an unknown outcome and is never replayed automatically. Completion observation waits for that run's message ID and a later assistant timeline entry before accepting an idle state. Missed ticks are not backfilled after restart.

The pinned 0.9.1 SDK can manage an existing-agent schedule through this protocol. Its unmodified CLI supports `schedule create` and `delete` for that target, but `schedule ls` hides it, while `inspect`, `logs`, `update`, `pause`, `resume`, and `run-once` reject targets other than `new-agent`. The upstream `paseo heartbeat` command supports an existing agent's create, cron update, and delete flow. The in-workspace CLI wrapper passes the native agent UUID to `heartbeat` and keeps scoped agent IDs for general commands; the pinned CLI contract test exercises all three heartbeat verbs through that wrapper. Full new-agent `paseo schedule` CLI management remains supported. The remaining `schedule` CLI verbs are absent from the pinned existing-agent client contract, as recorded in [#58](https://github.com/manziman/paseo-gateway/issues/58).

## Retained inventory and workspace labels

The controller captures bounded agent metadata before deliberately stopping a ready workspace. List and inspect can show retained entries while the workspace is suspended or archived, marked unavailable with their capture time. A stale snapshot is not a live permission prompt or evidence that an agent is still running. If a workspace cannot be captured and has no prior snapshot, inventory is explicitly unavailable. Replacing a workspace UID invalidates its old snapshot.

An unrelated unavailable workspace does not hide verified agents in the Desktop's broad active directory. The gateway returns verified rows with a directory **changes** cursor, so the Desktop merges them with its cache rather than treating omitted unknown agents as deleted. It includes tombstones for archived agents with readable retained metadata and deletions it has observed in the same client session. A request narrowed to an unaffected project remains a complete snapshot; an inspection of an unavailable target, or a listing with neither verified rows nor removals, returns an error instead of an empty result. The pinned response schema has no per-workspace partial-error field. A change response is not a complete delta journal: after gateway replacement, a deletion the new gateway has not observed may remain in a Desktop cache, even if its source is readable, until every source can provide a complete snapshot. Archived agents with readable retained metadata are explicitly removed during partial listings.

Workspace label definitions and UID-bound assignments live in the gateway's durable control records. They survive gateway replacement and appear on workspace descriptors through the pinned schema. Authorized workspace credentials can see and assign labels on their workspaces; only the owner can rename, recolor, or delete global definitions. Label list subscriptions receive updates and removals. The catalog and assignments have bounded size and use record versions to reject conflicting writes.

Cached backend event and terminal streams for a stopped or replaced workspace retire on the gateway's 10-second directory refresh. This is bounded polling, not instant target revocation; credential expiry and inbound operations are checked separately when traffic arrives.

## File transfers

The pinned upload request has no workspace field. The gateway accepts its binary frames into a short-lived, one-use staging handle. A later agent create or send operation supplies the explicit workspace identity; the gateway then uploads the bytes to that workspace's native daemon and substitutes its file reference before dispatching the agent operation. No workspace is inferred from a filename, prior connection, or default. Staging is limited to 32 MiB per file, 64 MiB across the gateway process, 16 entries per session, and five minutes. A consumed handle cannot be replayed; a gateway restart expires outstanding handles. If authorization, UID, or readiness changes during transfer, the agent operation is rejected before its prompt is sent.

Download-token responses contain a gateway handle rather than a daemon token. The handle is single-use, valid for 60 seconds, and bound to the authorized workspace UID. The HTTP route rechecks residency and authorization, does not follow redirects, and streams at most 512 MiB with a ten-minute deadline. Gateway replacement or reuse yields an expired or unknown handle. Client-visible URLs never contain daemon addresses or backend credentials.

## Local live acceptance

Run `node --import tsx scripts/protocol-live.ts CONFIG.json REPORT.json` against an explicitly selected Docker Desktop namespace and authorized Claude test project. The private configuration provides `context`, `namespace`, `project`, `identitySecret`, and `tls` (`caFile`, `serverName`). The harness verifies a reused-agent schedule, label persistence across client reconnect, and retained inventory after suspension. It writes a redacted report with image digests and a separate mode-0600 private cleanup file. Its schedule is deleted, and its test workspace is left suspended with its PVC retained. Backend shutdown can close the client's gateway socket, so the harness reconnects before reading the retained snapshot.

The transfer negative contracts have separate credential-free loopback tests in
`tests/download-failures.test.ts` and `tests/upload-session-recovery.test.ts`.
They verify expired/scoped-denied handles never reach the backend, real HTTP
client cancellation and origin revocation abort an upstream stream and release
capacity, malformed sizes and backend failures cannot return a successful
incorrect download or expose upstream error bodies, and the pinned SDK cannot
reuse a staged upload after session or gateway replacement. These tests complement
the existing two-daemon byte-integrity checks; they are not a live Kubernetes or
Desktop failure-injection claim.
