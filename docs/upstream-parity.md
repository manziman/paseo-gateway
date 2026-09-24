# Upstream 0.9.1 protocol and CLI evaluation

This independent gateway pins `@getpaseo/client`, `@getpaseo/protocol`, and the
workspace daemon to **0.9.1**. The inspected upstream tag resolves to
`81865852011df86aa0ad0ae411cb2f5e4078153f`. The multi-platform daemon image digest is
`sha256:9aae08258b6ff85853da3144ef48c2fd355cfe644500ca4d6041753da589098d`, verified with
`docker buildx imagetools inspect ghcr.io/getpaseo/paseo:0.9.1`.

The default workspace image installs Claude Code 2.1.274, Codex CLI 0.156.1, and
OpenCode 1.18.32. Runtime installation does not establish provider authentication.
Projects and credential profiles can select a custom workspace image; use an
immutable digest and rebuild from the supplied Dockerfile for extra toolchains.
Provider requests with `cwd` select that workspace's catalog. Requests without
`cwd` use the first ready authorized workspace; a heterogeneous installation
must query each workspace's catalog before selecting its runtime.

## Findings from the pinned official source

- [CLI daemon target selection](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/cli/src/utils/daemon-target.ts)
  gives explicit `--host` precedence over `PASEO_HOME`; setting both environment
  variables without an explicit target is an error. The
  [CLI transport](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/cli/src/utils/client.ts)
  accepts `PASEO_PASSWORD` and direct `tcp://` connection URIs.
- [CLI run](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/cli/src/commands/agent/run.ts)
  resolves or creates a workspace, then creates an agent. It sends per-spawn
  environment separately from provider config and preserves labels. It resolves
  `--workspace` using a workspace-directory query, so IDs must match that filter.
- [CLI agent listing](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/cli/src/commands/agent/ls.ts)
  and [permission listing](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/cli/src/commands/permit/ls.ts)
  make one unpaged `fetchAgents` request. The legacy client does not fetch the
  next page automatically. The gateway therefore returns the complete bounded
  aggregate for unpaged requests, and supports explicit cursor pagination for SDK
  consumers. Snapshots expire after five minutes or a disconnect; restart the
  listing after an expired cursor. Limits are 10,000 entries / 6 MiB per snapshot,
  four retained snapshots and 12 MiB of cursor storage per session. Exceeding a
  bound produces an error, never a silently partial directory.
- `ls --json` is **not** the raw SDK snapshot. Upstream emits display rows with
  `id`, `shortId`, `name`, `provider`, `thinking`, `status`, `cwd`, and relative
  `created`. Labels, absolute `createdAt`, and `lastError` remain in SDK snapshots;
  the gateway cannot make an unchanged CLI print fields it deliberately omits.
- The pinned [agent command registry](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/cli/src/commands/agent/index.ts)
  has no `agent worktree` subcommand. Use `workspace ls` and the supported
  `run --new-workspace worktree` flags for cluster workspaces. Legacy host-local
  `worktree ls` is a different RPC and does not enumerate these independent clones.
- `permit ls` aggregates `pendingPermissions` from agent snapshots. Permission
  IDs are opaque; only the accompanying agent ID is scoped to its workspace.
  Archived workspaces retain a validated directory snapshot, with status `closed`,
  no pending permissions and the label `paseo-gateway.availability=archived`.
  Provider persistence, runtime extras and permission inputs are omitted. The
  snapshot is removed with the workspace retention deadline. Suspended inventory
  remains explicitly unavailable; it is never silently treated as empty. A just-created
  CR without status has never hosted an agent and contributes an empty inventory.
- [0.9.1 wire schemas](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/protocol/src/messages.ts)
  retain legacy `create_agent_request` and add `agent.create.request`, atomic
  `workspace.create.request.agent`, and keyed creation subscriptions. Receipt
  fields alone do not authorize replay after an ambiguous connection failure.
  This gateway still requires inspection before retrying ambiguous mutations.
- [Client feature negotiation](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/client/src/connection/legacy.ts)
  requires `workspaceMultiplicity: true` to use the workspace registry. Without
  it, the SDK derives workspaces from agents and drops empty workspaces.
- [Schedules use slash RPC names](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/protocol/src/schedule/rpc-schemas.ts)
  such as `schedule/create`, `schedule/list`, `schedule/logs`, and
  `schedule/run-once`. New-agent schedules contain provider/model/mode/thinking,
  cwd and isolation; existing-agent schedule targets use GUIDs.
- [Workspace creation schema](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/protocol/src/messages.ts)
  supports `action: branch-off | checkout`, `refName`, `baseBranch`, `branchName`,
  and `checkoutSource` (plus legacy `githubPrNumber`). A Kubernetes workspace is
  an independent clone, so it implements the requested Git state without sharing
  a mutable worktree object store with other pods.

## Executable contract test

The reproducible runner installs the unmodified pinned CLI in a temporary directory,
executes the contract, and removes the temporary installation. CI runs it automatically:

```sh
npm run test:cli
```

This launches the actual CLI against a real loopback gateway with deterministic
workspace backend fixtures. It exercises `--host`, `ls -g -a --json`, `permit ls`,
`provider ls/models/diagnostic`, `daemon status`, `permit deny`, `run --workspace --provider --env --label --background`, `wait`,
`send`, `stop`, `agent reload`, `agent update`, and `archive`. It verifies wire
routing and executable output rather than claiming a paid-provider live run.
The regular unit suite skips this test unless the pinned CLI path is supplied.
The runner sets `PASEO_CLI_BIN`; set it yourself to reuse an existing isolated
0.9.1 installation when iterating locally.
Run `npm run test:upstream` and the Docker Desktop live suite for actual daemon,
provider and Kubernetes acceptance; those remain distinct from fixture evidence.

Daemon password/recycle/reboot administration is intentionally outside the
gateway protocol: use Kubernetes Secrets and pod/controller lifecycle. The
deployment has no long-lived daemon host to maintain.
`daemon status` reports the gateway package version, process and Node executable;
provider availability is aggregated from authorized ready workspaces. The status
RPC marks `providersComplete: false` when its bounded observation is incomplete.

## Cluster lifecycle

Workspace creation maps `origin/main` to the remote's `main` ref, uses full fetch
depth for worktree-style requests, and fetches `refs/pull/N/head` for PR checkout.
Agent creation waits up to 300 seconds (configurable through `readyTimeoutMs`) for Kubernetes readiness and reports the
workspace's scheduling/failure reason. A durable idempotency claim prevents an
acknowledgment loss from dispatching a second keyed agent mutation.

Archive saves bounded directory metadata before running the repository teardown
hooks. A failed hook retains compute and storage and refuses successful archive.
Scheduled workspaces retain storage for 24 hours after archive by default
(`scheduleRetentionSeconds` in the service configuration); terminal schedule
observation archives them after saving the run result. Manual workspaces retain
their existing retention policy.

Schedule run records retain upstream's GUID agent IDs plus a workspace ID. SDK
agent inspection and raw wait/send requests resolve GUIDs across workspaces;
ambiguous matches fail. CLI commands that resolve IDs client-side from `ls`
require the scoped ID shown by that listing, rather than the GUID in schedule logs.


## Durable creation and cold clones

The gateway advertises upstream `creationLifecycle` only when its workspace
operations service is installed. The official
[CreationClient](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/client/src/creation/index.ts)
and [daemon client](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/client/src/daemon-client.ts)
then use modern creation requests without the legacy 60-second RPC deadline.
`agent.create.request` and `workspace.create.request` emit accepted, readiness,
agent/prompt progress and terminal snapshots. `creation.subscribe.request` resumes
observation after reconnect; request responses remain terminal.

Creation journals persist idempotency fingerprints and redacted result metadata
before mutation. Replaying a completed key returns the retained result. If the
gateway is replaced with an unfinished intent, observation reports failed with
`outcomeUnknown: true`; it never repeats a possibly accepted spawn. Inspect the
reported workspace before choosing a new key. Scoped observation rechecks the
origin token and workspace access, and subscriptions end on disconnect or terminal
results. Journal records with a workspace UID follow that workspace's retention
purge. Failed pre-allocation records have no workspace and remain for operator
inspection; they contain no prompt, environment or provider configuration.

Tests exercise actual CLI feature negotiation with its legacy 60-second timer
scaled to 100 milliseconds and a 300-millisecond create response, plus durable
pending/reconnect, replacement, replay, scope revocation and concurrent-key cases.
