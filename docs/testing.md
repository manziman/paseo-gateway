# Testing

`npm run check` runs strict TypeScript checking, Biome formatting/linting, unit
and loopback WebSocket integration tests, then compiles the production service.
Tests use the actual pinned Paseo schemas/client. Lifecycle tests cover
idempotency, pod replacement, suspend/archive retention, foreign-resource
collisions and terminating-pod handling. Routing tests cover ID encoding,
conflicting routes, path traversal, content preservation, permission request IDs in
agent snapshots, and terminal slots. Backend deadline tests cover long agent waits,
unbounded waits released on disconnect, and ordinary mutation timeouts without replay.

The expanded suites cover credential projections and GitHub App renewal,
scoped authentication, durable creation observation, schedules and retention.
`npm run test:cli` installs the unmodified pinned upstream executable temporarily
and exercises agent and schedule commands against the gateway. CI runs these
contracts separately from the regular unit suite.

`npm run test:upstream` starts two real upstream daemon containers from
`paseo-workspace:dev`, fronts them with the gateway, and connects the actual
Paseo client. It checks directory aggregation, separate file contents, binary
file reads, terminal creation/subscription/input, gateway replacement with a
running terminal, and daemon replacement using retained volumes with a deliberately truncated
PID lock to exercise recovery from an interrupted write. It creates
uniquely named test resources and removes only those resources in `finally`.
It does not test Kubernetes or call a model. CI runs this suite separately.

## Docker Desktop acceptance

After `npm run dev:up` (import a subscription token for the second command):

```sh
npm run test:live
RUN_CLAUDE_LIVE=1 npm run test:live
```

The script creates its own loopback port-forward, two uniquely identified
workspaces, writes different sentinel contents, normally deletes one test Pod,
and verifies replacement and suspend/resume use the same PVC and preserve content.
It also replaces the gateway and verifies that host identity, workspace pod UIDs
and a running terminal survive while the directory generation changes.
The default run creates a separate infrastructure-only project and a clearly
unusable credential profile; it does not require or invoke Claude.
The opt-in variant starts concurrent Claude prompts with distinct markers and
checks actual assistant replies. It also starts a bounded text-generation prompt
and observes a running turn before replacing the gateway. After reconnect, it
requires the same turn ID to still be running, no pending permissions, and
completion with the expected final marker and exactly one original prompt.
The test never resends that prompt. The longer response provides a replacement
window; a run that reconnects after the turn finishes fails instead of claiming
active-turn continuity. It adds up to roughly 3,000 generated words to the
opt-in provider test.

After gateway/pod replacement and suspend/resume,
it checks all three agent timelines again in provider mode and asserts each original prompt occurs once. It leaves workspaces for desktop inspection. Each run creates new
workspaces; archive them afterward to release compute.

Set `PASEO_NAMESPACE` on setup, credential import, connection and live-test
commands to target a separate installation. The default remains `paseo-system`;
all Kubernetes access explicitly uses `docker-desktop`.

Additional headless fixtures are documented in [MVP operations](mvp-operations.md):
`test:lifecycle` verifies real PVC-finalizer waiting and ephemeral cleanup;
`test:auth` verifies scoped access and token expiry. The explicitly opted-in
`test:private` runs real Claude orchestrators and workers against an authorized
private repository and creates unmerged draft PRs. It attempts to pause its test
schedule even when assertions fail. These are live acceptance tests, not part of
credential-free CI. The credential renewal suite uses a mock GitHub endpoint;
it does not claim live GitHub App or shared provider subscription renewal.

Then exercise the desktop acceptance scenarios:

1. Connect, select a configured project, create two workspaces and start Claude.
2. Send distinct prompts, inspect both timelines, stop/archive agents, and
   answer a tool permission request. Verify the other workspace is unaffected.
3. While a Claude turn runs, restart only `deployment/paseo-gateway`. Restart
   `npm run dev:connect` if its port-forward exits. Verify host identity is
   unchanged, the agent continued, and the client receives a fresh snapshot.
4. Interrupt connectivity immediately after a prompt send. Reconnect and inspect
   history; verify neither gateway nor client silently resends the prompt.
5. Replace an idle workspace Pod and recover the timeline. Repeat during a turn
   and confirm interruption is visible rather than silently resumed by a prompt.
6. Rotate the subscription token using the [documented procedure](operations.md).
   Verify both workspaces run under the new token after explicit idle restarts.
7. Suspend a workspace, replace the gateway, and inspect inventory behavior.
   Unavailable inventory must be an error, never an authoritative deletion.

Record client version, dependency/image versions, Kubernetes/storage versions,
results, and limitations in `docs/compatibility.md`. Do not mark acceptance
complete based solely on mocked tests or file persistence. Provider history,
concurrent subscription authentication, desktop behavior and failure timing
need their own evidence.
