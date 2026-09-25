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

## Checkout DNS failure and retained recovery

A subsequent manual Desktop creation reached repository initialization but
failed before the daemon or agent started. The generic initializer error hid
the underlying Git failure. An isolated reproduction of the exact initializer
against a fresh directory on the same PVC captured a DNS lookup failure. A
separate Git fetch succeeded, and later checks of the DNS Service and both
CoreDNS endpoints passed all 18 queries. No cluster-wide DNS settings changed;
these observations establish an intermittent local resolution failure, not its
underlying network cause.

The failed workspace was suspended, its original checkout successfully
initialized, and it resumed Ready with the same Workspace UID and PVC. All
temporary diagnostic pods and the diagnostic-only directory were removed. A
separate fresh worktree-style SDK request then cloned, created a Claude agent,
and returned the exact requested assistant reply. That automated test workspace
was archived and its CR/PVC removed with UID preconditions. It used the same
gateway and workspace image digests recorded above; no retry fix was present in
those images. The operator subsequently archived the repaired workspace; its
retained storage was preserved.

Bounded transient-fetch retries and credential-safe initialization failure
categories are tracked in #68. Manual Desktop first-prompt completion remains
pending; the successful prompted SDK test does not substitute for that check.

## Bounded checkout retry qualification

The #68 implementation retries transient Git fetch failures at most three times
per initializer invocation within one shared 150-second deadline. Fixed failure categories replace raw Git
stderr in the initializer's termination message and controller status. Unit and
socket regressions cover redaction, deadline enforcement, process-group cleanup,
and propagation to the caller.

A credential-free Docker Desktop fixture injected DNS failures into the first
two fetch attempts, then executed real Git on the third. The workspace reached
Ready after exactly three attempts with zero initializer restarts. Its test
image digest was
`sha256:a2401a35e03188aca8bd2b7fb62ebaf9ca4ec32c3658296f526cffa904f4e22b`,
derived from retry implementation image
`sha256:a3887687ec7072738c81cc4de92852c745e9763f58f2792f4deeb72a0e400d70`.
Archive and teardown completed, and the owned Workspace, PVC, Project, and
CredentialProfile were removed with UID preconditions. This test qualifies
transient-failure recovery; it does not establish the cause of the earlier DNS
outage or live reporting after exhausting retries.

A subsequent always-failing DNS fixture qualified exhaustion reporting: both
the creation caller and Workspace status received the fixed
`CheckoutDnsUnavailable` diagnostic with three attempts. The termination envelope
reported the same stage, code, and attempt count. Neither caller nor status
contained the injected raw-stderr canary or URL. The derivative test image was
`sha256:29b6376e2892bf930aebaf4b23d88c5a874d02f0d5f8b7c75b70ae733520c7af`,
based on the workspace image in the live timeline section below, with that
section's gateway image. All owned fixture resources were removed with UID
preconditions.

This test also observed six fetch calls across a restarted initializer: the
Pod's `Always` restart policy lets kubelet start another bounded invocation.
That tested image did not implement a Pod-wide retry budget. A follow-up now
persists deadline, attempts, and terminal failure in the Pod emptyDir. Separate
initializer-process regressions verify no additional fetch after permanent failure
or three transient attempts; a killed initializer consumes its prewritten attempt,
and a new Pod may retry against the retained PVC. These are local process tests;
they do not retroactively change the earlier live result or qualify a new image
on Kubernetes. Live Pod-restart qualification remains required for the new image.

## Live Desktop timeline delivery

The operator confirmed the first prompted Desktop reply arrived, then reported
that the second reply and tool activity were missing. Read-only inspection found
both completed turns in stored history. A separate real Claude fixture reproduced
the failure through the pinned SDK: a tool call and final reply were stored, but
neither arrived at the live timeline observer before fetching history.

The gateway advertised the legacy broadcast timeline contract while its backend
client opted into owned subscriptions. The #69 fix advertises selective timelines
and uses the upstream legacy selective-subscription contract consistently at the
backend. Socket regressions cover two workspace GUIDs and independent observer
release; the real two-daemon contract verifies native delivery and release.

After deployment, the same Kubernetes reproduction received turn activity, tool
events, and the exact requested assistant reply through its live SDK observer
before any history fetch. Every observed event belonged to the selected agent.
The test workspace was archived and its CR/PVC removed with UID preconditions.
The user's existing conversation Pod retained its UID and had zero restarts.

Observed gateway digest:
`sha256:11edafe9173d8d00d929f921886e5e874b8c733fefaa9e4317596ae6f56d989e`.
Observed new workspace digest:
`sha256:cba69c0dfe4e5eb4f1b0ddf3275a6a0b7aaeb54582518770c981fe3356a75996`.
The integrated local check passed 310 unit/socket tests (two skipped), typecheck,
lint, build, 37 release tests, 14 qualification tests, and 14 PR-title tests.
Manual observation of Desktop's live tool widgets after reconnecting remains
pending; the SDK test does not assert desktop rendering or guarantee a provider
will emit reasoning events for every turn.

## Project source-ref selection

The #67 implementation passed a local Kubernetes test through the pinned SDK
against the gateway and workspace images recorded in the preceding section.
Remote branch suggestions, bounded query filtering, and validation of existing,
unused, and invalid branch names passed. A worktree-style request selected a
nondefault origin branch using its fully qualified remote ref and created a new
local branch in an isolated workspace.

Direct Git inspection in that workspace's UID-bound Pod confirmed the requested
local branch and equality of `HEAD`, `FETCH_HEAD`, and the selected source ref's
advertised commit. The fixture reached Ready, then archived successfully with
its Pod removed and original PVC preserved. After verifying teardown and storage
ownership, the fixture CR and PVC were deleted with exact UID preconditions.
This qualifies the SDK creation
path and selected-ref checkout; interactive Desktop picker rendering remains a
manual check. Custom workspace images must include the ref-inspection helper;
older image overrides were not qualified by this run.

## First-turn catalog handoff and latency

On 2026-09-25, a manual initial tool prompt was persisted and completed in 2.343
seconds after the workspace became Ready about 12 seconds after creation. The
operator nevertheless observed a multi-minute delay before seeing its output.
The timestamps establish that the delay was outside provider execution.

A source-backed replay of the pinned Desktop's viewed-timeline synchronizer
confirmed that late subscription normally catches up with an authoritative tail
fetch. A separate real first-turn SDK fixture returned creation completion at
33.2 seconds and fetched the completed turn by 36.0 seconds, including preceding
cold Project checkout discovery. That replay did not query the draft's separate
workspace catalog and therefore did not qualify Desktop's complete handoff.

The missing dependency was reproduced separately: Desktop creates a draft as
soon as the Workspace ID arrives, then requests models at the Workspace cwd.
It withholds draft-to-agent handoff while those models are loading. The first
workspace-scoped request failed at 0.39 seconds because the Pod was Pending. At
15.98 seconds, a read against the Ready workspace returned loading rows with no
Claude models. A manual later read at 17.61 seconds returned 15 Claude models,
and the assistant was stored by 18.64 seconds; no scoped model-ready push was
observed. This is tracked in #71.

The two automated fixtures were archived with teardown confirmed, and only their
CRs/PVCs were removed using exact UID preconditions. The user's workspace was
left intact. Private prompts, endpoint details, and raw histories are excluded
from this report.

## Directory query amplification and memory qualification

The initial directory list and every subscribed refresh read one shared label
catalog once per workspace. With 23 suspended workspaces, each performed 23
identical reads. The #70 request-scoped batch fix reduces each to one read while
retaining label freshness, distinct workspace labels, UID replacement checks,
and scoped authorization. Its integrated check passed 312 tests (two skipped),
lint, typecheck, build, and the release/qualification checks.

The gateway also had 25 historical memory-limit restarts over about 13 hours,
with the last recorded termination `OOMKilled` under a 1 GiB limit. Later samples
were stable near 401 MiB RSS. Compressed read loops returned near their initial
heap usage after the request-timeout lifetime expired, although RSS stayed at
an allocator high-water mark. These observations do not prove an unbounded
store-read leak or establish label-query amplification as the sole restart
cause. Longer candidate qualification remains tracked in #72.

## First-turn catalog fix qualification

The #71 fix aligns the backend with native legacy event delivery and forwards
fully materialized provider entries. Global/home catalog pushes are dropped
rather than relabeled as repository catalogs. A new workspace request can wait
for readiness; if that wait times out, a UID- and authorization-bound interest
can still publish the correct catalog automatically when Ready. Interests are
limited to four per session and expire after five minutes. Healthy workspace
reads do not consume those pending slots. Closing the session aborts waits and
prevents late backend connections.

A fresh Docker Desktop Claude fixture made exactly one catalog request as soon
as the Workspace ID arrived. The Pending request succeeded after readiness;
automatic updates carried 15 Claude models by 15.3 seconds. Creation completed at
17.2 seconds, then the first timeline subscription delivered both tool activity
and the assistant live by 20.0 seconds. No second catalog pull or repeated
history fetch was needed to make the response visible through the SDK sequence.

A separate credential-free test image delayed repository initialization by 35
seconds. Its only workspace catalog request failed as still Pending at 25.2
seconds. The workspace reached Ready at 50.7 seconds; an automatic matching-cwd
update delivered 15 Claude models at 60.2 seconds, without another client pull.
This verifies recovery after the initial RPC timeout, including the periodic
readiness check's delay. Archive/teardown and exact-UID cleanup of the owned
workspaces, PVCs, and delayed fixture configuration completed. The user's Pod
retained its UID and both container restart counts remained zero.

Observed gateway digest:
`sha256:eb71a5c6c817d1bc251a2858dbd4716ce2e82302cfa8dd946284e7d1aa482a8c`.
The normal workspace used the previously recorded
`sha256:cba69c0dfe4e5eb4f1b0ddf3275a6a0b7aaeb54582518770c981fe3356a75996` image.
The intentionally delayed derivative was
`sha256:e17f6bbe89d734b274eaad41808aa3ed08ed652154445941ecd5bf6e5e751eb1`.

The exact integrated source tree passed 325 tests (two skipped), lint, typecheck,
build, and release/qualification checks. The pinned native two-daemon contract
asserts that a fresh cwd produces a resolved full provider update despite
contradictory caller capabilities. Unit/socket tests cover Pending readiness,
timeout recovery, healthy-workspace capacity, global/repository catalog
isolation, identity and access changes, and close/expiry races.

Temporary metadata-only relay tracing was removed after qualification. On
2026-09-25, the operator confirmed that a fresh Claude chat displayed command
activity and the requested reply automatically, without reopening or refreshing.
This qualifies the corrected first-chat handoff in the ongoing Desktop session;
the operator did not report a measured duration. The automated 20-second result
above is not a measurement of that manual run.

The operator then created a second Claude chat in a separate workspace and
confirmed that switching between the two showed only each conversation's own
messages and activity. Two-workspace Desktop isolation therefore passed in this
session. Fresh-preference, zero-Ready cold-start discovery remains a separate
acceptance gate; the reconnect/history result is recorded below.

The planned 35-minute read-only memory sampler for #72 was interrupted after
19.5 minutes when its local helper session ended. Its partial observations do
not qualify a completed soak, establish long-term stability, or explain the
historical restarts.

## Desktop reconnect test setup

After quitting and reopening the app, the operator saw both saved histories but
the host remained reconnecting. Both localhost helper ports refused connections
and their original tool sessions were gone; the gateway remained Ready with
zero restarts. Visible history could be cached, so this is not a server reconnect
pass.

The temporary localhost forward and TLS-verifying relay were restored as
user-scoped macOS services independent of the desktop process. The real desktop
Origin handshake and two fresh authenticated SDK project-list round trips then
passed. The operator subsequently confirmed that the desktop was connected and
both histories were intact, completing the manual reconnect/history check after
the helper interruption. No gateway deployment or user workspace was changed
during that recovery. This does not qualify uninterrupted app restart with the
new helper arrangement or a deliberately controlled gateway replacement.

The independent follow-up memory sampler completed 35 minutes with 70 samples
and observed one gateway restart with termination reason `OOMKilled` on the same
candidate. The process terminated at 15:31:11 UTC on 2026-09-25, between samples
at 15:31:00 and 15:31:30. Workspace phase counts remained unchanged. The gateway
recovered, but #72 remains an unresolved stability issue; the successful manual
reconnect does not qualify memory stability. The post-restart cgroup peak does
not bound the memory spike in the terminated container.

## Desktop terminal isolation

On 2026-09-25, the operator opened a terminal in each of the two test workspaces,
printed a distinct harmless marker in each, and confirmed that both terminals
worked and their output stayed separate when switching between them. This
qualifies the manual terminal routing/isolation check.

## Desktop attachment upload

On 2026-09-25, the operator attached a small text file through the desktop chat
control and asked the agent to read it. The returned contents matched the test
marker. This qualifies manual attachment upload and agent access in the selected
workspace. Opening or downloading an agent-generated file remains a separate
acceptance gate.

## Desktop generated file links

The operator's generated-file check failed with `No file found` for the test
filename. Read-only checks confirmed that the file existed in the selected
workspace with the expected contents, and the gateway's direct file read
returned those bytes. The same file was absent from the other test workspace.

Replaying Desktop's workspace-scoped suffix lookup reproduced the failure:
`directory_suggestions_request` with a workspace `cwd` was rejected as
unsupported. Cwd-less project discovery has a separate existing handler. The
failure is tracked in #73; attachment upload success does not cover it.

Commit `6bbb049` forwards that workspace-scoped request through the existing
workspace authorization and lifecycle checks. The exact Session regression was
red before the fix. All 328 unit/socket tests pass (two skipped), together with
lint, typecheck, build, and release/qualification checks. The pinned native
two-daemon suite passes the exact suffix lookup with relative paths, distinct
files per workspace, and refusal to expose another workspace through traversal
or absolute queries. Cwd-less project discovery remains covered separately.

The corrected gateway was deployed locally with digest
`sha256:66248cc28fa7ebfccce4808f9e83ddfa605f1f3e33e52808ef8bd2820107a946`.
The original live reproduction now resolves the existing file in its workspace,
returns no match from the second workspace, and reads matching bytes. HTTP
download also returns matching contents and reuse of the consumed handle is
rejected. Neither prompt nor file was recreated. Both existing workspace Pod
UIDs and restart counts were unchanged by the gateway-only rollout. The operator
subsequently confirmed that clicking the existing Desktop file link opens the
file with matching contents. This completes the manual file-link opening check;
the HTTP download observation above remains separately automated evidence.

## Desktop schedule controls

The schedule form initially showed an empty model search. The exact
project-scoped snapshot request returned 15 ready Claude models, and applying
that response to the unmodified upstream schedule form produced 14 selectable
model rows. The operator subsequently created the test schedule without a
gateway change. This records successful creation, not a fix for the intermittent
empty picker; the latter remains an unqualified observation under #65.

The operator confirmed that editing the daily time, saving, pausing, and
resuming all worked and displayed the correct state. The manual Run now attempt
produced exactly one successful run in about 17 seconds, with stored output
matching the requested marker. Its configured `archiveOnFinish: true` caused
the completed agent to be archived, explaining its absence from active chats.
The operator confirmed that the schedule row's Last run time updated. No repeat
dispatch was used during diagnosis. The operator then deleted the owned test
schedule and confirmed that it disappeared from the Schedules screen, completing
this new-agent schedule check.

## Desktop existing-agent heartbeat target

The operator confirmed that a future-only existing-agent heartbeat displayed its
correct available chat target, without a `Target gone` or `Agent unavailable`
warning. The fixture had no runs and was created without sending an agent prompt.
The operator also confirmed that changing its future cadence, saving, and deleting
the heartbeat worked. This completes the manual existing-agent heartbeat check
for #64 without dispatching a turn.

This observation used the temporary memory-diagnostic gateway derived from the
same deployed routing source as the file-link qualification above. The diagnostic
adds bounded memory/event metadata probes; this UI observation does not qualify
memory stability or a published image.

## Bounded memory diagnostic follow-up

A temporary diagnostic build of the deployed gateway ran from 16:51:23 through
17:16:23 UTC on 2026-09-25 without a restart. Its 7,452 memory samples had a maximum
gap of 273 ms. Peak process RSS was about 356 MiB and peak cgroup usage about
374 MiB; the earlier rapid allocation was not reproduced. Operation traces were
rate-limited, and allocation wrappers plus synchronous sampling can alter timing.
This bounded observation does not resolve #72 or qualify memory stability.

The normal gateway was restored afterward with digest
`sha256:113c37e0af111775a52adef7dcbcd662a2e581a1e9fcab9e06bbd5d90cafabbf`.
Authenticated Desktop-origin and reconnect probes passed. During that rollout
and the next workspace image build, Docker Desktop's filesystem reached 100%.
Both retained user workspace daemons failed startup with `ENOSPC` while writing
their PID locks; their Pod UIDs remained unchanged. Reclaiming 3.3 GB from exact,
unused project-generated intermediate build-cache records restored free space.
No images, volumes, or workspace records were removed. Both daemons recovered
automatically in their original Pods by 17:23:30 UTC, each with six daemon
restarts and no transport restart. The original file-link lookup, matching bytes,
HTTP download, single-use handle, and cross-workspace isolation checks passed
again. No agent prompt was resent. The simultaneous normal-image memory
observation is affected by this storage-pressure interval and is being restarted
as a fresh observation after recovery.

## Scheduled run archive preference

The `archiveOnFinish: false` live regression passed against the restored normal
gateway image above. One future-only new-agent schedule was explicitly fired
once; its successful output matched the test marker, and the workspace remained
Running/Ready with a Ready Pod and a fetchable agent after completion. The test
then deleted only its owned schedule, archived its owned workspace, observed
controller teardown, and removed its CR and retained PVC with UID preconditions.
Both deletions were observed. This qualifies the non-archiving schedule behavior
in #74; the earlier manual schedule separately exercised `archiveOnFinish: true`.

After the storage recovery, both user test agents were idle and their complete
current timelines were readable, with 11 and 6 entries respectively, no page
gaps, and their expected test replies. No same-agent pre-incident snapshot was
available for an exact byte-for-byte history comparison. No prompt was resent.

## Pod-wide checkout budget qualification

A later local qualification used workspace image
`sha256:f7e76745f971ef599a959e504c7af55601bb68cac11f372a58a8d41b7686cd63`
with gateway image
`sha256:113c37e0af111775a52adef7dcbcd662a2e581a1e9fcab9e06bbd5d90cafabbf`.
Two temporary derivative images changed only the Git executable used for fault
injection; they did not change the production initializer.

The DNS derivative (`sha256:c83d8dfbe1aaf718ce0acd1fabfe61b4d69c0da6eab51444ba394d1aeac23368`)
made exactly three fetch calls across at least two checkout-container restarts.
The permanent-authentication derivative
(`sha256:40218ddcde18f171053fde9dea6fc66ecf490060e69bc4ec84f9993bdf882778`)
made exactly one fetch across at least two restarts. Both emitted the expected
fixed reason and attempt count through termination diagnostics, workspace status,
and the creation caller without exposing synthetic raw-stderr canaries. Neither
failure fixture started its daemon.

After explicit suspension and removal of the injected fault, the same workspace
became Ready on a new Pod using the unmodified workspace image. Its PVC UID and
sentinel remained unchanged and a real Git checkout was verified. A second
suspend/resume retained a dirty file and did not create a retry receipt, confirming
that the checkout-ready marker skipped Git. No agent or prompt was created. Both
owned test workspaces were initially suspended with their PVCs retained. After
review of the evidence, controller-managed archive teardown completed for both;
their workspace records, PVCs, projects and credential-free profiles were removed
with UID preconditions and observed deletion. No user resources were changed.

The first recovery probe used the initializer-only `/data` mount in the daemon
and failed. Correcting the harness to use the daemon's actual workspace mount
completed the checks on the same workspace/PVC; no product patch or repeated
failure fixture was needed. The original failed harness report is retained alongside
the successful recovery report. These tests establish Pod-wide retry fencing and
retained recovery, not the cause or repair of the earlier environment DNS outage.
