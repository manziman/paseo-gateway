# Compatibility and acceptance

## Version pins

| Component | Pin |
| --- | --- |
| Paseo client/protocol packages | 0.7.1 |
| Upstream workspace daemon | 0.7.1, digest in `docker/workspace.Dockerfile` |
| Inspected upstream source | `3e59adb4dcea119e2ce281852fd0f6d4afbb8684` |
| Claude Code CLI | 2.1.274 |
| Gateway runtime | Node 24 |
| Kubernetes TypeScript client | 2.0.0 |
| Initial local cluster target | Docker Desktop Kubernetes 1.34.3 |

The daemon image also includes its own pinned Claude Agent SDK. The CLI pin
alone does not establish provider runtime compatibility. Keep SDK, protocol,
daemon and provider checks together when upgrading; update exact versions,
the lockfile and image digest, then rerun contract/live acceptance.

## Evidence

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
| Unit tests and real SDK-to-gateway socket tests | Passed: 20 tests |
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
| Gateway replacement while a Claude turn runs | Pending live verification |
| Actual desktop reconnect after an ambiguous mutation | Pending live verification |

The live evidence above was captured before renaming the Kubernetes API group
to `paseo-gateway.manziman.github.io`. The rename has type/unit/schema checks;
the existing cluster remains on its original group. A fresh installation under
the renamed group has not yet repeated the live acceptance suite. See the
[transition constraints](operations.md#api-group-transition).

## POC boundaries

- One trusted owner, one namespace and one active gateway. Direct desktop
  connectivity only; no relay, Tailscale implementation, Hub or tenant system.
- Public HTTPS repositories. No private Git credential distribution yet.
- Project configuration is managed through Kubernetes. Arbitrary host filesystem
  browsing and creating host projects through the desktop are not supported.
- Lists currently support up to 200 entries within the requested page limit;
  an oversized result fails explicitly rather than returning a truncated snapshot.
- Suspended/unreachable agent inventory is unavailable until the workspace is
  running. The gateway does not claim offline browsing of every agent.
- File/Git operations and terminal traffic route to their workspace. Attachment
  upload requests without workspace identity and HTTP download-token URLs need
  a separate routing contract and are not supported yet.
- Optional daemon administration, plugins, voice, schedules and workspace labels
  are not implemented. Unsupported RPCs return an explicit error; feature flags
  alone are not considered proof that required desktop flows work.
- Agent-originated built-in Paseo tools are disabled to prevent untracked local
  workspace creation. An upstream extension or a cluster-authoritative tool
  adapter is still required for full v0.1 support. This is a feasibility gap,
  not permission to maintain a fork.
- Credential rotation is manual and uses the supported subscription-token
  interface. Automatic renewal and shared login-file refresh are not claimed.
- No EKS support claim until storage, encrypted networking and node-failure
  fencing are validated there.

The full [v0.1 specification](../paseo-kubernetes-high-level-spec.md) remains the
release bar. Passing the POC's automated checks is not full v0.1 acceptance.
