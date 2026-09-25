# Pinned client acceptance matrix (pending)

For a short operator-run desktop walkthrough, use the [manual desktop acceptance checklist](manual-desktop-acceptance.md).

This matrix tracks [headless parity issue #16](https://github.com/manziman/paseo-gateway/issues/16)
and the required unchanged v0.1 desktop flows in [issue #62](https://github.com/manziman/paseo-gateway/issues/62).
The gateway pins the upstream CLI, SDK and wire protocol at 0.9.1. Fixture tests
show handlers and shapes; they do not prove a desktop action or real provider run.
For each live run record client version, gateway/workspace image digests, chart
revision, scenario ID, timestamp, redacted observed result, and linked issue for
FAIL/BLOCKED. Keep environment identity, account IDs, private endpoints/repos,
credentials, and raw prompts out of public evidence.

## Headless capability inventory

| # | Contract / expected shape | Handler and existing evidence | Completion gate |
| --- | --- | --- | --- |
| 1 | `schedule/create`, `list`, `inspect`, `update`, `delete`, `logs`, `run-once`, `pause`, `resume`; run records carry agent and workspace IDs | `src/gateway/schedules.ts`; `tests/schedules.test.ts`; `scripts/cli-test.ts` | Existing-agent target and real scheduled run/restart, including ambiguous dispatch, remain blocking until #58 and live evidence. |
| 2 | CLI `run`, `ls -g -a --json`, `wait`, `send`, `stop`, `archive`, `agent update/reload`; SDK agent list/ref | `src/gateway/workspace-operations.ts`, `agent-inventory.ts`; `tests/cli-contract.test.ts`, `tests/client-parity.test.ts`; `scripts/cli-test.ts` | Live multi-Pod run and exact CLI/SDK result comparison. CLI `ls --json` emits display rows with `id`, `shortId`, `name`, `provider`, `thinking`, `status`, `cwd`, relative `created`; inspect SDK for labels, absolute `createdAt`, and `lastError`. |
| 3 | Workspace create/list/archive; branch-off/base/new-branch, PR checkout, reuse; teardown failure retains data | `src/gateway/workspace-operations.ts`; `tests/workspace-operations.test.ts`; `scripts/checkout-live.ts` | Live Git branch/PR/reuse plus nonzero teardown evidence. Pinned CLI has no `agent worktree` command; use supported `run --new-workspace worktree` and `workspace ls`. |
| 4 | Private clone, push, PR with scoped Git identity | `scripts/private-live.ts`; `docs/credential-profiles.md` | Live private fixture with redacted fetch/push/draft PR evidence and credential scope. |
| 5 | Provider `ls`, `models`, `diagnostic`, refresh; runtime image choice | `scripts/cli-test.ts`; `docs/upstream-parity.md` | Exact real provider catalog and refresh after version change; multiple authenticated runtimes depend on #57. |
| 6 | Per-spawn `--env`, profile file projection, provider/home configuration | `scripts/cli-test.ts`; `tests/credentials.test.ts` | Live environment and file behavior with no value logged. |
| 7 | Single-authority rotating provider and Git identity renewal | `docs/credential-renewal.md`; #56/#57 | Authenticated renewal, concurrent Pods and expiry recovery remain blocking. |
| 8 | In-Pod scoped CLI `run`/`wait`, separate worker Pod; denial outside scope | `scripts/private-live.ts`; `tests/auth.test.ts` | Real orchestrator/worker and cross-role denial. |
| 9 | Retained/ephemeral PVC policy and bounded cleanup | `tests/teardown.test.ts`; `docs/operations.md` | Live retention/cleanup with PVC and Secret UID checks. |
| 10 | Capacity refusal and actionable `Pending`/unschedulable errors | `tests/controller.test.ts`; `docs/operations.md` | Live quota/capacity and bounded failure evidence. |
| 11 | `permit ls/deny` aggregates two Pods; provider permission IDs stay opaque | `scripts/cli-test.ts`; `tests/gateway.test.ts` | Live two-Pod pending/deny and suspended inventory behavior; #59. |
| 12 | Schedule logs, workspace status/logs, `lastError`, OOM/eviction | `tests/schedules.test.ts`; `docs/operations.md` | Live failure types, SDK error field and run history. |
| 13 | Reference cache and cold clone fallback | `docs/reference-cache.md`; `scripts/cache-benchmark.mjs` | Live digest-pinned cold/warm comparison where configured. |
| 14 | Configured private egress | `docs/networking.md`; `docs/eks-qualification.md` | Positive and negative live network probes under #61. |
| 15 | CLI/client/protocol/daemon 0.9.1 pin | `package.json`; `docs/upstream-parity.md` | Re-run contract/live tests with exact release artifacts. |
| 16 | `daemon status` only | `scripts/cli-test.ts` | Status reflects gateway/workspaces. Host recycle/password/reboot administration is intentionally excluded. |

`tests/client-parity.test.ts` uses the pinned SDK over an actual loopback
WebSocket to check a 240-agent aggregate, immutable cursor pages, filters,
`lastError`, archived/suspended snapshots and a replacement directory generation.
The pinned SDK's public list type omits the wire `sync` field even though its
runtime returns that field; the test checks this boundary explicitly. These are
fixture contracts, not live deployment evidence. An unavailable
suspended workspace must not appear as an authoritative empty directory. Check
the full generation after gateway replacement. These are required checks even
when CLI fixture tests pass.

## Unchanged desktop and SDK checklist

Use an unmodified desktop app and the pinned SDK. Record the desktop's exact
version; a compatible newer desktop is valid versioned live evidence. Connect to
the gateway through the deployment's protected access path. Record the displayed
result and a redacted wire/result observation for each item. Repeat workspace
flows across at least two isolated Pods and verify no cross-workspace routing.

| ID | Action and observable result | Required live evidence |
| --- | --- | --- |
| `desktop.connection` | Add direct endpoint, authenticate, disconnect/reconnect; no misleading capability shown | Connection, auth denial, reconnect and advertised capability snapshot |
| `desktop.project` | List/open configured project, including empty project | Project identity and authorization boundary |
| `desktop.workspace` | Create branch/PR workspace, list, inspect, archive; empty/archived/suspended display is truthful | Workspace UID/phase transitions; no host filesystem browse promise |
| `desktop.agent` | Create, send, wait, stop, reload and archive from two Pods | Scoped IDs, terminal state, prompt count, `lastError` on failure |
| `desktop.timeline` | Subscribe, receive ordered events, disconnect, resume with no duplicate prompt | Agent IDs, event order and final history |
| `desktop.permission` | Observe pending permission and approve/deny in intended Pod; other role denied | Unchanged opaque permission ID and resolution |
| `desktop.git-file` | Branch/PR checkout, list/read/write file, attachment upload and download | Correct Pod and workspace identity, binary integrity; provider-free Docker transfer evidence in `scripts/upstream-test.ts`, desktop observation still required |
| `desktop.terminal` | Open/read/write/close terminal on two Pods, replace gateway, reconnect | Terminal slot identity, output order, no cross-Pod bytes |
| `desktop.schedule` | In the exposed Schedules screen, create/list/edit/pause/resume/run now/delete a new-agent schedule | Cadence/status/last-run display and exactly one created agent turn; run logs are CLI/SDK evidence |
| `desktop.existing-agent-schedule` | With an operator-created existing-agent heartbeat on a Ready test agent, inspect its target label/status, edit its cron cadence, and delete it | The correct agent is shown as present; a false “Target gone” or “Agent unavailable” is FAIL. Target display, cadence edit and deletion passed in Desktop 0.9.2 on 2026-09-25; see the [local evidence](local-parity-qualification.md#desktop-existing-agent-heartbeat-target). |
| `sdk.directory` | Page beyond 200; filter; archived/suspended; inspect `lastError` | Full records, no duplicates/omissions, explicit unavailable state |
| `sdk.reconnect` | Replace gateway and receive new full directory generation | All existing workspaces/agents visible after reconnect |
| `sdk.ambiguous` | Drop response after create/prompt/file mutation, reconnect and inspect | No silent replay; unknown outcome reported where needed |
| `sdk.capabilities` | Compare advertised features with authorized handlers | Every advertised action works for that role; denied action is not advertised |

Use `scripts/client-acceptance.mjs --evidence <local-json>` to grade this list.
It checks evidence completeness only; it does not execute the desktop or substitute
for the observations. An unexecuted scenario remains BLOCKED. Start with a local
JSON object like `{ "desktop.connection": { "status": "BLOCKED" } }` and add
`"kind": "live-desktop"` (or `"live-sdk"`) plus a nonempty `"evidence"` local
reference when a scenario has passed. The script prints only IDs and status.
`desktop.existing-agent-schedule` requires its own desktop observation; new-agent
schedule or CLI/SDK evidence cannot satisfy it. The pinned 0.9.1 desktop joins
schedule targets to directory agents by exact ID in
[schedule derivation](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/app/src/schedules/schedule-derivation.ts),
and the pinned schedule target schema requires a GUID. The installed 0.9.2
desktop bundle retains the same exact-ID lookup. The gateway now uses
[durable GUID projection](guid-agent-identity-plan.md), with registered legacy
scoped IDs accepted through the compatibility path. The operator confirmed the
correct target display, cadence edit and deletion in Desktop 0.9.2; this does
not substitute for the separate scheduled-dispatch and recovery checks.

Optional voice/plugins, host filesystem browsing, Hub/relay, host
recycle/password/reboot operations, and active-active HA are not release gates
for this parity milestone.
