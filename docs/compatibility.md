# Compatibility and acceptance

## Version pins

| Component | Pin |
| --- | --- |
| Paseo client/protocol packages | 0.9.1 |
| Upstream workspace daemon | 0.9.1, digest in `docker/workspace.Dockerfile` |
| Inspected upstream source | `81865852011df86aa0ad0ae411cb2f5e4078153f` |
| Claude Code CLI | 2.1.274 |
| Codex CLI | 0.156.1 |
| OpenCode | 1.18.32 |
| Gateway runtime | Node 24 |
| Kubernetes TypeScript client | 2.0.0 |
| Initial local cluster target | Docker Desktop Kubernetes 1.34.3 |

The daemon image also includes its own pinned Claude Agent SDK. The CLI pin
alone does not establish provider runtime compatibility. Keep SDK, protocol,
daemon and provider checks together when upgrading; update exact versions,
the lockfile and image digest, then rerun contract/live acceptance.

Current implementation and CLI evidence are described in [upstream parity](upstream-parity.md),
[credential profiles](credential-profiles.md), and the [MVP plan](mvp-plan.md).
Passing fixture contracts does not establish live private-repository or provider acceptance.

## Published alpha and remaining parity

The latest published baseline is `v1.0.0-alpha.3`. Its
[qualification record](https://github.com/manziman/paseo-gateway/releases/download/v1.0.0-alpha.3/qualification.md)
adds clean public-artifact installation, cross-role denial, upgrade/rollback and
reinstall evidence to the earlier development-candidate results below. The
[completion plan](parity-completion-plan.md) tracks remaining implementation and
live qualification. EKS deployment and validation are the final operator-assisted
step; they are not implied by Docker Desktop results.

## Development candidate evidence (0.9.1)

Acceptance on 2026-09-24 used Docker Desktop Kubernetes 1.34.3, Docker Engine
29.8.0, and the `standard` local-path StorageClass. The isolated `paseo-mvp`
installation uses gateway/workspace image tag `dev-20260924070805-29642`.
Existing installations and their volumes were preserved.

| Check | Evidence |
| --- | --- |
| Strict typecheck, lint, build, generated CRDs and Helm lint | Passed |
| Unit and SDK/socket regressions | 153 passed; two executable CLI contracts run separately |
| Unmodified upstream CLI 0.9.1 | Agent lifecycle and full schedule command contracts passed against fixtures |
| Two actual upstream daemons | Files, terminals, aggregation, gateway replacement and daemon recovery passed |
| Scoped credentials against deployed gateway | Project filtering, cross-project denial, mint denial, active-socket expiry and new HTTP/WS rejection passed |
| Cross-role live denial | Skipped: no different-role workspace fixture; covered by unit tests |
| Archive/retention against Kubernetes | Retained and ephemeral teardown/cleanup passed; a deliberately held PVC finalizer prevented premature collection |
| Runtime cleanup | Archived test pods, Services and scoped access Secrets removed; no foreign resources deleted |
| Private repository | HTTPS clone/commit/push/draft PR passed; repaired SSH credentials used by a separate real Claude worker |
| Agent-originated CLI | Actual Claude Bash tool spawned a sibling pod and invoked CLI wait; distinct worker result verified |
| Per-spawn environment | Official CLI `--env` reached an actual Claude Bash tool; a harmless sentinel value was read without inspecting other credentials |
| Private PR checkout and repeated archive | SDK checkout matched remote `refs/pull/N/head`; repeated archive preserved stored timestamps, retained the same PVC and removed the pod without affecting existing agents |
| Scheduled private workflow | Run-once started a Claude orchestrator; its separate SSH-backed worker committed a marker, pushed a branch and opened a verified draft PR; orchestrator teardown/archive and retained inventory passed |
| Real Claude recovery on Kubernetes | Same active turn survived gateway replacement; all three histories retained exactly one original prompt after gateway/pod replacement and suspend/resume; PVC UIDs/files and terminal continuity verified |

The private fixture uses an explicitly authorized test repository and credentials
loaded from local files/authentication into Kubernetes Secrets. Its provider
configuration, tokens and repository contents are not committed as test fixtures.
The acceptance schedule was paused after verification. Draft PRs remain unmerged
test artifacts. At that candidate, GitHub App renewal had only mocked
provider/CAS evidence, and authenticated Codex/OpenCode runs and shared Codex
subscription refresh were unverified. The current development work below does
not retroactively qualify those published artifacts.

## Full-parity development work

The completion branch adds existing-agent schedules, retained suspended
inventory, workspace labels, staged attachments, HTTP downloads, a dedicated
Codex subscription authority, optional verified TLS, and configurable PVC access
modes. These changes are not yet a published or fully qualified release.

The unmodified pinned SDK and two actual upstream daemon containers have passed
attachment byte integrity, late workspace binding, consumed-handle rejection,
HTTP download integrity, cross-workspace path denial and handle invalidation
after gateway replacement. Local TLS tests verify trusted HTTPS/WSS and reject
untrusted certificates and incorrect hostnames. Two real Claude agents have run
concurrently through TLS on Docker Desktop with distinct per-spawn environment
values and histories. Read-only probes on two deployed workspace Pods confirmed
that the daemon accepts loopback connections, refuses its Pod-IP plaintext port,
and is reachable through its Service using verified TLS from the gateway. These
are Docker Desktop observations, not EKS NetworkPolicy or node-fencing evidence.
The Codex authority and bridge have passed concurrent worker prompts, actual
native renewal, projected access replacement on unchanged Pods, and both idle
and active-turn gateway recovery. OpenCode has passed concurrent prompts through
an OpenAI-compatible model gateway, catalog discovery, and idle/active-turn
gateway recovery. Credential expiry/revocation and explicit operator credential
replacement remain unqualified. See [local qualification](local-parity-qualification.md),
[provider acceptance](provider-acceptance.md) and the
[client acceptance matrix](client-acceptance.md) for remaining live gates.
The implemented behavior and transfer limits are documented in
[schedule, inventory and file contracts](schedules-inventory-files.md).

## Historical POC evidence (0.7.1)

Implementation session: 2026-09-17, macOS arm64. Live acceptance ran on
Docker Engine 29.8.0 with the containerd image store, Kubernetes 1.34.3 (kind),
and the `standard` StorageClass (`rancher.io/local-path`, ReadWriteOnce).
The complete infrastructure suite passed after increasing Docker’s disk limit
and adding recovery for truncated daemon PID locks; disk space remained at
41.5 GiB free after the run. The Claude-enabled live suite also passed using
one subscription token across two pods, with distinct assistant responses and
exactly one occurrence of each original prompt after every recovery step.
Desktop UI acceptance and the remaining failure scenarios below are separate.

| Check | Status |
| --- | --- |
| Unit tests and real SDK-to-gateway socket tests | Passed: 24 tests |
| Two actual upstream daemons through the gateway | Passed |
| Binary file isolation and terminal slot routing | Passed |
| Gateway replacement retains running terminals | Passed |
| Upstream container replacement retains files and recovers a truncated PID lock | Passed |
| Original test files after Docker disk exhaustion and restart | Passed: both original PVCs recovered |
| CRDs and chart accepted by the Docker Desktop Kubernetes API | Passed |
| Docker Desktop deployment, two workspace pods and isolated file writes | Passed |
| Kubernetes gateway replacement: identity, workspace pods, terminal, new generation | Passed |
| Kubernetes workspace replacement and suspend/resume | Passed: same PVC UID and retained file contents |
| Concurrent real Claude prompts and timeline recovery | Passed: two pods, distinct assistant replies, history retained after gateway/pod replacement and suspend/resume |
| Subscription token replacement/expiry | Pending live verification |
| Unchanged desktop app end-to-end | Pending live verification |
| Gateway replacement while a Claude turn runs | Passed through the pinned SDK: same running turn ID after reconnect, expected completion, one original prompt |
| Actual desktop reconnect after an ambiguous mutation | Pending live verification |

A fresh installation under `paseo-gateway.manziman.github.io` repeated the
Claude-enabled recovery suite on 2026-09-18 in `paseo-validation`. It uses gateway
and workspace image tag `dev-20260918100116-26510`. The original installation in
`paseo-system` remains on its original group and was not migrated or replaced;
its volumes remain intact. See the [transition constraints](operations.md#api-group-transition).

This phase found and fixed permission request IDs being rewritten inside agent
snapshots and a 55-second gateway deadline incorrectly truncating longer
`wait_for_finish_request` calls. New regression tests cover both. The active-turn
scenario also exposed the original 512 MiB gateway limit as insufficient;
[measured memory usage and the revised budget](operations.md#gateway-memory-budget)
are documented separately. The final chart passed the complete provider suite
without instrumentation and with zero gateway container restarts. The two-daemon
upstream suite passed again.

The provider run checks two concurrent short prompts and a longer text response.
It requires the long response's turn ID to remain active across gateway
replacement, then checks all three histories after workspace pod replacement
and suspend/resume. This proves the SDK path; it does not establish desktop UI
behavior or loss-of-acknowledgement handling. Superseded test workspaces were
archived with their PVCs retained.

## Current boundaries

- One namespace and one active gateway, with an owner credential and scoped
  project/profile credentials for workspace agents. Direct CLI, SDK and desktop
  connectivity; no relay, embedded Tailscale, Hub or tenant system.
- Private Git fetch/push, projected identities/signing keys and per-profile runtime
  images are implemented. See credential-profile setup and acceptance requirements.
- Project configuration is managed through Kubernetes. Arbitrary host filesystem
  browsing and creating host projects through the desktop are not supported.
- Explicit directory pages support at most 200 entries each, with session-scoped
  cursors. Unpaged CLI requests return bounded complete snapshots. Oversized
  results fail explicitly instead of silently truncating.
- Archived and gracefully suspended agent metadata is retained, with stale
  snapshots explicitly marked unavailable for live provider operations. A failed
  workspace without a captured snapshot reports unavailable inventory. Metadata
  excludes transcripts, pending permissions and provider persistence details.
- File/Git operations and terminal traffic route to their workspace. Attachment
  uploads are bounded and staged until an agent operation identifies the target;
  HTTP downloads use short-lived, single-use gateway handles. Both paths retain
  workspace UID and authorization checks.
- New-agent and existing-agent schedules and their history are implemented.
  Workspace label definitions and assignments are persisted with UID fencing.
  Plugins and voice remain outside this milestone.
  Daemon status reports the gateway process; recycle/password/local-host
  administration is intentionally replaced by Kubernetes lifecycle and Secrets.
- Agent-originated built-in Paseo tools are disabled to prevent untracked local
  workspace creation. The in-pod CLI wrapper routes sibling creation to the gateway
  with a scoped, renewable credential; workflow policy remains with the consumer.
- GitHub App installation-token renewal is implemented. Claude setup-token
  rotation remains manual. An experimental Codex authority owns a dedicated
  native login and projects access-only credentials to workers; concurrent live
  renewal and gateway recovery have passed locally. Independently copied refresh-token files are
  unsupported. See [credential renewal](credential-renewal.md).
- No EKS support claim until storage, encrypted networking and node-failure
  fencing are validated there.

The full [v0.1 specification](../paseo-kubernetes-high-level-spec.md) remains the
full-parity acceptance bar. An explicitly experimental public alpha follows the
[release policy](release-policy.md); artifact publication is not full v0.1 acceptance.

## Related follow-up issues

- [Configurable advertised server information](https://github.com/manziman/paseo-gateway/issues/11): typed builder and configurable name implemented; features remain tied to supported behavior.
- [Redis-backed session storage and multi-replica HA evaluation](https://github.com/manziman/paseo-gateway/issues/12)
- [Decomposition of complex protocol/lifecycle functions](https://github.com/manziman/paseo-gateway/issues/13): lifecycle, inventory and authentication now have separate modules; further review can identify smaller seams.
