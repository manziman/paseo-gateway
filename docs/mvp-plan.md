# Headless Kubernetes MVP implementation plan

Source: [parity evaluation #16](https://github.com/manziman/paseo-gateway/issues/16).


## Implementation tracking

- [ ] https://github.com/manziman/paseo-gateway/issues/17 — Protocol and headless CLI parity on Paseo 0.9.1
- [ ] https://github.com/manziman/paseo-gateway/issues/18 — Credential profiles, private Git, and configurable workspace runtimes
- [ ] https://github.com/manziman/paseo-gateway/issues/19 — Kubernetes-authoritative workspace creation and teardown
- [ ] https://github.com/manziman/paseo-gateway/issues/20 — Durable schedules with upstream CLI and SDK compatibility
- [ ] https://github.com/manziman/paseo-gateway/issues/21 — Scoped in-pod CLI access for orchestrator and worker agents
- [ ] https://github.com/manziman/paseo-gateway/issues/22 — Single-authority credential renewal and GitHub App token broker
- [ ] https://github.com/manziman/paseo-gateway/issues/23 — Workspace retention, ephemeral storage, and safe garbage collection
- [ ] https://github.com/manziman/paseo-gateway/issues/24 — Capacity admission and actionable workspace failure diagnostics
- [ ] https://github.com/manziman/paseo-gateway/issues/25 — Warm repository caches and configurable private-network egress
- [ ] https://github.com/manziman/paseo-gateway/issues/26 — MVP integration acceptance and deployable release documentation

Related improvements: #11 (advertised information), #12 (HA evaluation), #13 (module decomposition). Execution order: protocol/profile/auth foundations → workspace lifecycle → schedules and scoped worker spawning → renewal/retention/capacity → caches/egress → integrated release acceptance.

Completion requires the live acceptance in #26, not just child implementation commits. Preserve the existing standalone CLI contract and report upstream limitations explicitly. In particular, upstream `ls --json` formats a subset of the full SDK agent record; verify labels/lastError through the SDK where the CLI omits them.

## Release constraints

One TypeScript service, Kubernetes lifecycle authority, independent project branding, no upstream fork. Existing volumes retain their default preservation policy. All local commands explicitly target Docker Desktop. Private-repository/paid-provider acceptance requires designated test credentials and a disposable repository; never publish secrets in logs, issues or CRs.

## [Protocol and headless CLI parity on Paseo 0.9.1](https://github.com/manziman/paseo-gateway/issues/17)

Parent: #16

## Scope

Rows 2, 5 (provider RPCs), 11, 15; coordinates dependency PR #14.

## Implementation plan

Keep one TypeScript service and Kubernetes as lifecycle authority. Use exact pinned upstream contracts, focused modules, and namespaced resources. Document behavior and failure semantics alongside implementation.

## Acceptance criteria

- [ ] Pin client, protocol, daemon digest, and test CLI to compatible 0.9.1 artifacts; record upstream source revision.
- [ ] Exercise run/wait/ls/send/stop/archive/agent update/reload/worktree and provider ls/models/diagnostic/refresh using the real CLI or exact upstream SDK contracts. Preserve JSON shapes, env, labels, timestamps and lastError.
- [ ] Paginate aggregate inventory beyond 200 without duplicate or missing scoped IDs; document explicit unavailable offline inventory and never report unreachable work as deleted.
- [ ] Enumerate and deny pending permissions across two pods without rewriting provider permission IDs.
- [ ] Retain two-daemon binary routing, active-turn recovery and no ambiguous mutation replay tests.

## Validation and completion

Add meaningful unit/contract regressions and update operator documentation. Record actual command results and remaining external test prerequisites before closure. Passing unit tests alone does not satisfy live criteria.


## [Credential profiles, private Git, and configurable workspace runtimes](https://github.com/manziman/paseo-gateway/issues/18)

Parent: #16

## Scope

Rows 4, 5 (runtime images), 6.

## Implementation plan

Keep one TypeScript service and Kubernetes as lifecycle authority. Use exact pinned upstream contracts, focused modules, and namespaced resources. Document behavior and failure semantics alongside implementation.

## Acceptance criteria

- [ ] Namespaced validated credential profile references multiple Secrets/ConfigMaps for env and files; no credential values in CRs, logs, URLs or status. Reject traversal, reserved paths/env and missing keys.
- [ ] Project/profile image and resource overrides work for checkout and daemon; document reproducible pinned Claude/Codex/OpenCode and custom toolchain images.
- [ ] Private HTTPS fetch and push use projected credentials; git author/signing identity and gh authentication survive pod replacement. Per-agent --env reaches provider.
- [ ] Opt-in live fixture clones a designated private repo, commits, pushes a test branch, opens a draft PR, and verifies secret redaction. External test credentials/repo must be provided explicitly.

## Validation and completion

Add meaningful unit/contract regressions and update operator documentation. Record actual command results and remaining external test prerequisites before closure. Passing unit tests alone does not satisfy live criteria.


## [Kubernetes-authoritative workspace creation and teardown](https://github.com/manziman/paseo-gateway/issues/19)

Parent: #16

## Scope

Row 3; atomic workspace-plus-agent CLI path; one agent pod for each newly spawned worker.

## Implementation plan

Keep one TypeScript service and Kubernetes as lifecycle authority. Use exact pinned upstream contracts, focused modules, and namespaced resources. Document behavior and failure semantics alongside implementation.

Depends on: credential profiles, protocol parity.

## Acceptance criteria

- [ ] Upstream CLI/SDK worktree creation maps branch-off/base/new-branch/PR checkout to cluster workspace records; reuse preserves existing workspace identity.
- [ ] workspace.create initial-agent payload is honored after readiness; idempotency keys prevent duplicate cluster allocation without replaying ambiguous provider mutations.
- [ ] Configurable fetch depth/refs support private default branches and refs/pull/N/head. Invalid refs/flags fail before allocation.
- [ ] Archive executes paseo.json teardown hooks before compute/storage cleanup; nonzero/timeout refuses archive and retains data; forced destructive bypass is not implicit.
- [ ] Unit and live tests cover create/reuse/branch/PR, failed checkout/readiness, failed hook and repeated archive.

## Validation and completion

Add meaningful unit/contract regressions and update operator documentation. Record actual command results and remaining external test prerequisites before closure. Passing unit tests alone does not satisfy live criteria.


## [Durable schedules with upstream CLI and SDK compatibility](https://github.com/manziman/paseo-gateway/issues/20)

Parent: #16

## Scope

Row 1; schedule run history portion of row 12.

## Implementation plan

Keep one TypeScript service and Kubernetes as lifecycle authority. Use exact pinned upstream contracts, focused modules, and namespaced resources. Document behavior and failure semantics alongside implementation.

Depends on: workspace lifecycle, protocol parity.

## Acceptance criteria

- [ ] Serve schedule create/list/get/update/delete/logs/run-once/pause/resume using pinned upstream RPC schemas.
- [ ] Persist validated cron/timezone/project/profile/provider/model/mode/thinking/prompt and Forbid/Allow concurrency; no missed-tick backfill.
- [ ] Each fire records a durable run and creates isolated workspace plus agent with paseo.schedule-id label; concurrent reconciliation/restart cannot duplicate a fire.
- [ ] Persist dispatch intent before sending; ambiguous create acknowledgement marks run interrupted/unknown and is not silently replayed.
- [ ] History retention is bounded; run-once and cron runs visible through schedule logs and agent inventory; test DST, invalid config, concurrency, restart, failed spawn and cleanup.

## Validation and completion

Add meaningful unit/contract regressions and update operator documentation. Record actual command results and remaining external test prerequisites before closure. Passing unit tests alone does not satisfy live criteria.


## [Scoped in-pod CLI access for orchestrator and worker agents](https://github.com/manziman/paseo-gateway/issues/21)

Parent: #16

## Scope

Row 8.

## Implementation plan

Keep one TypeScript service and Kubernetes as lifecycle authority. Use exact pinned upstream contracts, focused modules, and namespaced resources. Document behavior and failure semantics alongside implementation.

Depends on: workspace lifecycle, credential profiles.

## Acceptance criteria

- [ ] Workspace CLI reaches the in-cluster gateway Service by default and reads a short-lived scoped bearer from a mounted file.
- [ ] Orchestrator can create a sibling workspace/agent, wait and read results within allowed project/credential profile; worker gets a separate pod.
- [ ] Scoped auth cannot impersonate owner, change project configuration, select another credential profile or access another project; reject expired/tampered/revoked grants.
- [ ] Retained signing identity and token renewal survive gateway replacement; archiving origin revokes access; no gateway owner password or Kubernetes service-account token in workers.
- [ ] Contract tests cover scope escape attempts; opt-in live test runs paseo run and wait inside orchestrator pod.

## Validation and completion

Add meaningful unit/contract regressions and update operator documentation. Record actual command results and remaining external test prerequisites before closure. Passing unit tests alone does not satisfy live criteria.


## [Single-authority credential renewal and GitHub App token broker](https://github.com/manziman/paseo-gateway/issues/22)

Parent: #16

## Scope

Row 7.

## Implementation plan

Keep one TypeScript service and Kubernetes as lifecycle authority. Use exact pinned upstream contracts, focused modules, and namespaced resources. Document behavior and failure semantics alongside implementation.

Depends on: credential profiles.

## Acceptance criteria

- [ ] One broker owns GitHub App installation token mint/renew; private key remains gateway/broker-only, workers receive short-lived token access. Renew before expiry with bounded backoff and redacted failures.
- [ ] Git fetch/push and gh commands in long-running pods read current token rather than frozen env/subPath snapshots; test token replacement and expiry.
- [ ] For rotating provider OAuth, verify pinned provider supports externally managed access-only credentials. Never distribute shared refresh-token files to independent provider processes.
- [ ] Implement supported single-authority provider path where upstream permits it; otherwise explicitly reject unsafe shared configuration, document exact upstream blocker and retain issue open for subscription parity.
- [ ] Test concurrent refresh, restart, failed renewal, token write conflict and no credential leaks.

## Validation and completion

Add meaningful unit/contract regressions and update operator documentation. Record actual command results and remaining external test prerequisites before closure. Passing unit tests alone does not satisfy live criteria.


## [Workspace retention, ephemeral storage, and safe garbage collection](https://github.com/manziman/paseo-gateway/issues/23)

Parent: #16

## Scope

Row 9.

## Implementation plan

Keep one TypeScript service and Kubernetes as lifecycle authority. Use exact pinned upstream contracts, focused modules, and namespaced resources. Document behavior and failure semantics alongside implementation.

Depends on: workspace lifecycle.

## Acceptance criteria

- [ ] Opt-in retained/default and ephemeral workspace policies; omitted policy retains all existing PVCs.
- [ ] Archived TTL deletes only gateway-owned UID-matching PVC after successful teardown and stopped compute; active, foreign and preexisting retained volumes are never collected.
- [ ] Archive timestamp/GC status survives restarts; retries and conflicts are idempotent; failed hook/storage deletion remains visible.
- [ ] Ephemeral emptyDir behavior and irrecoverable pod-loss semantics are explicit; transcript/history retention matches configured policy.
- [ ] Clock-controlled tests and isolated live fixtures verify retention boundary, restart, owner mismatch and no deletion before hook success.

## Validation and completion

Add meaningful unit/contract regressions and update operator documentation. Record actual command results and remaining external test prerequisites before closure. Passing unit tests alone does not satisfy live criteria.


## [Capacity admission and actionable workspace failure diagnostics](https://github.com/manziman/paseo-gateway/issues/24)

Parent: #16

## Scope

Rows 10, 12 (workspace observability), 16.

## Implementation plan

Keep one TypeScript service and Kubernetes as lifecycle authority. Use exact pinned upstream contracts, focused modules, and namespaced resources. Document behavior and failure semantics alongside implementation.

Depends on: credential profiles, workspace lifecycle.

## Acceptance criteria

- [ ] Per-project and namespace running-workspace limits reject concurrent over-cap creates; idempotent reuse does not consume another slot.
- [ ] Profile resource requests/limits apply; direct CR creation cannot bypass controller capacity gating.
- [ ] Pending/unschedulable, checkout failure, OOMKilled/evicted and daemon termination have durable machine-readable status with bounded/redacted messages; CLI caller receives failed-spawn reason.
- [ ] Authenticated bounded per-workspace logs/status endpoint and deployment runbook provide a single diagnostic entry point; scoped clients cannot read other roles.
- [ ] Daemon status maps to gateway/workspaces; host recycle/set-password/nightly reboot explicitly excluded in favor of Kubernetes lifecycle.
- [ ] Tests cover admission races, terminal pods, unavailable API and log authorization.

## Validation and completion

Add meaningful unit/contract regressions and update operator documentation. Record actual command results and remaining external test prerequisites before closure. Passing unit tests alone does not satisfy live criteria.


## [Warm repository caches and configurable private-network egress](https://github.com/manziman/paseo-gateway/issues/25)

Parent: #16

## Scope

Rows 13, 14.

## Implementation plan

Keep one TypeScript service and Kubernetes as lifecycle authority. Use exact pinned upstream contracts, focused modules, and namespaced resources. Document behavior and failure semantics alongside implementation.

Depends on: credential profiles.

## Acceptance criteria

- [ ] Optional read-only reference clone/cache inputs never become workspace source of truth; git dissociation preserves clone after cache disappears.
- [ ] Fresh checkout fallback works without cache; profile image toolchains documented; writable caches are not unsafely shared across identities.
- [ ] Configurable namespace/profile egress rules include DNS, gateway and approved private/API endpoints without embedding Tailscale.
- [ ] Document CNI NetworkPolicy limitations, Docker Desktop versus EKS, tailnet subnet-router/operator pattern and provider allow-list maintenance.
- [ ] Tests inspect rendered policy/volumes and clone independence; benchmark cold versus warm fixture without unsupported performance claims.

## Validation and completion

Add meaningful unit/contract regressions and update operator documentation. Record actual command results and remaining external test prerequisites before closure. Passing unit tests alone does not satisfy live criteria.


## [MVP integration acceptance and deployable release documentation](https://github.com/manziman/paseo-gateway/issues/26)

Parent: #16

## Scope

Release gate for #16, all implementation children, and expanded #11-#13.

## Implementation plan

Keep one TypeScript service and Kubernetes as lifecycle authority. Use exact pinned upstream contracts, focused modules, and namespaced resources. Document behavior and failure semantics alongside implementation.

Depends on: all implementation packages.

## Acceptance criteria

- [ ] Clean install on Docker Desktop via documented commands, structural CRDs/RBAC/Helm validation, pinned images/dependencies, strict typecheck/lint/unit/contract suites pass.
- [ ] Run scheduled orchestrator -> isolated private-repo worker -> branch push/draft PR -> completion -> teardown/retention workflow using actual CLI/SDK.
- [ ] Gateway restart during active work retains agent turn/history; pod loss emits interruption and never duplicates mutation; expired credentials fail observably.
- [ ] Compatibility matrix distinguishes automated evidence, manually tested behavior and blocked external credentials; do not label MVP complete while required parity gaps remain.
- [ ] Upgrade instructions retain existing volumes and independent-project attribution; EKS is documented deployment target but no claim of validated EKS fencing without live evidence.

## Validation and completion

Add meaningful unit/contract regressions and update operator documentation. Record actual command results and remaining external test prerequisites before closure. Passing unit tests alone does not satisfy live criteria.
