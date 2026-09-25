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
| Gateway after desktop Origin fix, during credential rejection and recovery probes | `sha256:d4057090c6173af51496eba730271b6e3d2efd69462bf42094d93b4c896e49c8` |
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

A separate Codex rejection fixture used only generated invalid native login
material in its own authority Secret and credential profile. The running gateway
reported `CodexReauthenticationRequired:RefreshFailed` within the bounded test.
After the refresh lease expired, it reported `CodexReauthenticationRequired`,
left the authority resource version unchanged, and published no worker access
Secret. The fixture profile and authority were removed after checking their UIDs
and ownership labels. This proves native failure reporting and the durable
no-retry fence; it does not prove provider-side revocation or actual expiry.

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
credential replacement were not tested in that provider run.

An isolated Claude credential fixture passed generated-invalid rejection, a
second rejection after its Secret was changed while the original Pod remained
running, success with the existing valid credential after suspend/resume and a
new Pod UID, and retention of the same workspace UID and PVC. The unmodified
Paseo daemon reports Claude's authentication failure as an `idle` turn with an
explicit assistant error message; the fixture required that message and absence
of a success marker. Direct Claude CLI testing returned a structured error and
exit code 1, so the report identifies the distinct Paseo surface accurately.
The fixture was suspended and its Secret reset to the generated invalid value.
The selected checks passed **4/4**; actual provider expiry/revocation and
rotation between two independently valid credentials were **skipped**.

A separate OpenCode fixture used a generated fake key only. It produced a
bounded structured authentication error with no success marker (**1/1 selected
check passed**); recovery with a valid key was **skipped**. No valid credential
was read or copied for this OpenCode probe. Its workspace was suspended, the
fixture Secret remains invalid, and the temporary loopback proxy tunnel was
closed. These probes used the prior workspace image and the later gateway image
listed above; they do not qualify the later workspace image for live providers.

Unchanged desktop flows, platform failure injection, writer fencing, and EKS
deployment and network qualification remain
**BLOCKED pending live evidence**.

The first manual desktop connection exposed a real gateway rejection of the
unmodified app's `paseo://app` Origin. Temporary password-free diagnostics proved
the request used the correct `/ws` path and bearer. A socket regression reproduced
the HTTP 401 before the fix. The gateway now accepts that exact application
Origin without broadening its Host allowlist or bypassing authentication. Six
socket cases cover the real Origin, wrong credentials, an untrusted Host, and
lookalike origins. The deployed local relay probe now connects with `paseo://app`
while lookalikes still receive HTTP 401. This is a handshake check; completion of
the manual desktop workflow remains separate. Temporary header instrumentation
was removed before resuming the user's test.


## GitHub App private repository and renewal acceptance

The isolated App-backed worker passed seven live checks on 2026-09-24: repository
scope, absence of App key/Kubernetes API credentials in the worker, private Git
fetch, projected-identity commit/push/draft-PR creation, live token renewal consumed
without restart, actual disposable-token revocation/rejection, and recovery after
an explicitly requested replacement mint. The workspace was created through
verified gateway TLS. Revocation returned HTTP 204; the same token then received
HTTP 401 and Git failed. A new installation token restored both API and Git access
with unchanged Pod UID and restart counts. Neither the App installation nor its
private key was revoked. The test workspace was suspended; its PVC and unmerged
draft PR remain for private inspection.

Observed gateway digest: `sha256:66f3cd4d9d45a4f852dd6daeb79c544ce3c41456a0935024561f20602dbcf656`.
Observed workspace digest: `sha256:4895730f269c6ebc297f9b039d0b661beb7f63036dc3ad23e16eb55e03d4fc9c`.
Actual elapsed-time expiry is still untested; early renewal and real revocation do
not establish that separate condition. The harness emits no repository, App,
installation, token or PR identity in its public report.

## Cold-start project model discovery

The manual Desktop test reported a Models picker stuck on Loading. An SDK probe
reproduced rejection of `/projects/<id>` as a workspace path. After adding
project-scoped discovery, a real daemon probe found a second problem: the pinned
daemon returned an empty legacy `entries` array alongside a populated
`compactSnapshot`. Expanding that snapshot with the upstream codec fixed the
catalog reader. A compact-only regression and a credential-free real daemon
contract are now included in CI for both supported CPU architectures.

On 2026-09-24, Docker Desktop delivered a project-scoped asynchronous catalog with
15 ready Claude models while every user workspace remained suspended. The
temporary probe used an isolated checkout and was removed before publication.
A gateway replacement interrupted the preceding probe; the replacement gateway
automatically reclaimed its UID-bound resources after the stale-run deadline,
retried discovery, and delivered the catalog to an already waiting subscription.
No agent or model prompt was created by this catalog test.

Observed gateway digest:
`sha256:569cddaeb8c11b82ad85012eac0e16adb22ddb5572fb4c420cabe113458c9775`.
The probe used the previously recorded workspace image
`sha256:a23986a8fa639a50f58aa170951e99d01c16b5993ad81d05d18dec39abfb1edb`.
The pinned Desktop source proof verifies project-cwd cache routing and model
selection from a ready snapshot. The operator subsequently confirmed that models
load in Desktop. Submission then exposed the separate project checkout-status
routing gap tracked in #66; completion of the first prompted Chat remains pending.

The tested gateway image predates the subsequent same-fingerprint, known-provider
error-row enhancement, which has unit coverage. Cross-profile live isolation and
initial-discovery failure UI qualification remain open. See
[provider discovery](provider-discovery.md) for the bounded cleanup behavior and
the pinned Desktop's limitation when a failed first probe has no known provider
identity.

## Project checkout inspection before Desktop creation

After model discovery worked, Desktop submission failed with
`requestType=checkout_status_request code=gateway_operation_failed`: the virtual
project path was still routed through a workspace-only handler. The pinned SDK
reproduced that exact failure. Project inspection now returns the real disposable
source checkout's status under the authorized logical project path, fenced by
the same UID/configuration fingerprint as discovery. This is a cached source
revision snapshot, not a persistent shared checkout.

On 2026-09-24, the same local SDK request passed after upgrade, including migration
from a provider-only catalog record. The native source checkout reported a
detached Git revision and a remote. A Desktop-style worktree creation request
without an explicit selected ref then created a Ready workspace and an initial
Claude agent with a GUID. Checkout inspection of that workspace also passed.
No model prompt was submitted by this automated test. Archive completed, and the
test workspace and its retained PVC were removed using exact UID preconditions.

Observed gateway digest:
`sha256:fd26ba3d9579afd0a9bc7a9c3cbf8a96aa3e8d99488da44c6c4387ba3e91059d`.
The workspace used the previously recorded
`sha256:a23986a8fa639a50f58aa170951e99d01c16b5993ad81d05d18dec39abfb1edb` image.
The integrated check passed 277 unit/socket tests plus lint, typecheck, build,
release, title, and qualification checks. A real daemon contract verifies native
Git status and path mapping; unit tests cover cache migration, authorization
races, valid SSH URLs, and the end-to-end checkout request deadline.

The integrated run also reproduced an uncaught connection reset during rejected
WebSocket authentication. The gateway now owns raw upgrade-socket errors until
the WebSocket handler takes over; denied, pending, and failed authentication have
deterministic reset regressions. The full check then passed without that error.

Manual first-prompt completion remains unobserved. Project branch/ref picker
discovery is tracked separately in #67; the successful default creation test
does not qualify interactive source-ref selection or forge search.
