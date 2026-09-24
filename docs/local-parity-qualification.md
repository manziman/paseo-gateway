# Local parity qualification (partial)

Observation date: 2026-09-24. Source branch: `feat/full-parity`; candidate images
were built from the working tree based on commit `b351722`, before candidate
commits. These are local fixture
observations, not a release, desktop, or EKS qualification claim. Keep the
operator's cluster identity, endpoints, repositories, credentials, and raw
session data outside public evidence.

| Running role | Observed Kubernetes image ID digest |
| --- | --- |
| Gateway during transport and Codex probes | `sha256:8716bc93ea32cd6c1014f57d8f9775ec299394b7cf6bb6c3f0af2081ee6d897c` |
| Gateway after projected-file startup fix | `sha256:66f3cd4d9d45a4f852dd6daeb79c544ce3c41456a0935024561f20602dbcf656` |
| Workspace daemon and TLS sidecar used for live provider tests (two or more Pods) | `sha256:a23986a8fa639a50f58aa170951e99d01c16b5993ad81d05d18dec39abfb1edb` |
| Later workspace image tested with isolated upstream and native auth contracts | `sha256:4895730f269c6ebc297f9b039d0b661beb7f63036dc3ad23e16eb55e03d4fc9c` |

The read-only `scripts/local-transport-probe.mjs` passed all three checks on
**each** of two ready workspace Pods. From the sidecar in the same Pod network
namespace, the daemon answered on loopback port 6767 and refused its Pod IP on
that port. From the gateway Pod, the workspace Service on port 6767 completed a
TLS 1.2-or-newer handshake with certificate chain and hostname verification.
The probe read Pod and Service metadata and made connection attempts only; it
read no Secrets and changed no cluster resources.

The isolated `UPSTREAM_TEST_IMAGE=paseo-workspace:parity-final3 npm run
test:upstream` suite passed against two unmodified upstream daemons. It checked
aggregated directories, binary file reads, terminal IDs and slots, terminal
input, native HTTP download bytes, workspace path isolation, one-use download
handles, two-Pod late-bound attachment uploads with bytes verified inside each
owned fixture container, consumed-upload rejection, gateway replacement and
new directory generation, and recovery from a truncated daemon PID lock. The
Docker fixture owned and removed its containers and volumes. The pinned native
Codex `0.156.1` auth contract also passed without using credentials.
The same isolated upstream and native auth contracts subsequently passed on the
later workspace image listed above. The live provider runs below used the prior
workspace image, so this later contract run is not a live-provider qualification
of the newer image.

The local Codex subscription fixture passed four concurrent native prompts with
independent histories, an access-only worker projection without an authority
mount, a second native authority renewal, and fresh agents on the same Pods
after the renewed access projection arrived. A controlled gateway replacement
preserved all four completed histories exactly once while both worker Pod UIDs
remained unchanged; committed credential authority was reused. A further
gateway replacement during a running tool call reconnected the same turn with
one original prompt and tool call and unchanged worker Pod UIDs. Actual
credential expiry or revocation and a separately selected credential
replacement remain untested. A separate local Claude protocol run passed agent
discovery, label reconnect, one scheduled
prompt, and the suspended-workspace aggregate snapshot.

A fresh client process after gateway replacement also recovered the suspended
workspace's label catalog, descriptor, and agent snapshot. The workspace UID
stayed unchanged and its Pod remained absent throughout; label update and
deletion succeeded without resuming it. This follow-up is reproducible with
`scripts/protocol-restart-check.ts` and the private fixture cleanup record.

A manual read-only probe from an existing workspace used the installed CLI over
the verified-TLS gateway connection. Eight commands succeeded, covering global
and workspace listing, provider and model discovery, permit and schedule lists,
and connected daemon status. This probe script was temporary and is not shipped
as a reusable acceptance harness.

The first local OpenCode attempt exposed a real startup failure: a projected
configuration file caused Kubernetes to create home-directory ancestors owned
by root before the nonroot checkout container started. A separate nonroot
`prepare-home` init step now creates the home and file-parent directories before
checkout mounts the file. Two **fresh** local PVC workers completed that sequence
and ran pinned OpenCode `1.18.32` through a temporary loopback-only proxy tunnel.
Both real prompts returned their distinct environment sentinels with independent
histories, and provider discovery refreshed. A second fresh pair then passed
completed-history recovery after a gateway replacement and recovery of a running
tool call after another gateway replacement, without replaying the prompt or
tool call. The tunnel, model alias, and key are absent from this report. All six
owned OpenCode workspaces were suspended after testing, with their PVCs and
histories retained; the earlier failed PVCs were not modified. The temporary
tunnel was stopped. Actual credential expiry/revocation and separately selected
credential replacement remain **BLOCKED pending distinct evidence**.

Unchanged desktop flows, platform failure
injection, writer fencing, and EKS deployment and network qualification remain
**BLOCKED pending live evidence**.
