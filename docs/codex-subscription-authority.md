# Codex subscription authority decision and contract

Status: implemented experimentally for Codex **0.156.1** and Paseo **0.9.1**.
Live Docker Desktop evidence covers two concurrent Kubernetes workers using a
dedicated subscription login, actual native renewal, access-only delivery and
gateway replacement, including interruption during a running tool. Actual
expiry/revocation and explicit credential replacement remain separate gates in
#56/#57. Worker Pod failure during a turn is not covered by gateway replacement. API-key runs do not
satisfy subscription gates.

## Supported native contracts

The gateway delegates login and refresh to the unmodified Codex executable. It
never calls a private OAuth endpoint. Codex's generated public protocol includes
`getAuthStatus({includeToken: true, refreshToken: true})`. The pinned
[account processor](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/account_processor.rs)
refreshes the managed login through its native auth manager and returns only the
access token. This legacy RPC is version-pinned and must be checked when upgrading;
its presence must not be inferred from a newer Codex release. The authority first
loads managed auth with `getAuthStatus({includeToken: false, refreshToken: false})`,
then requests refresh/export. The pinned native auth manager otherwise can treat a
cold-cache reload as sufficient without rotating credentials. Successful renewal
must change native access or refresh state; an unchanged export fails closed.

Workers use the documented experimental `chatgptAuthTokens` app-server login and
`account/chatgptAuthTokens/refresh` callback. See the official
[app-server authentication contract](https://learn.chatgpt.com/docs/app-server#auth-endpoints).
The host supplies access credentials; the worker does not own OAuth renewal. The
existing Paseo adapter does not expose this hook, so `docker/codex.mjs` bridges only
the authentication exchange over stdio, leaving the upstream executable and Paseo
package unmodified. It completes external login before returning initialization
to Paseo and consumes refresh requests instead of forwarding them as permission
prompts. Ordinary provider protocol messages pass through unchanged.

The authority uses an isolated private temporary `CODEX_HOME` and native file
storage. No workstation config, ambient provider environment, or OS keyring is
inherited. Native stdout is parsed privately and stderr is discarded. Temporary
files are removed after the child exits. The returned native auth file is stored
in a Kubernetes Secret before worker access is published. JWT claim decoding only
extracts account/expiry metadata from this native export; it is not an independent
signature verification or authentication mechanism.

## Bootstrap and delivery

Create a **dedicated login** in an isolated directory, configured with
`cli_auth_credentials_store="file"`, using the official Codex login flow. Stop all
other consumers of that login before importing its `auth.json` into an authority
Secret. Do not copy a login that an active workstation still refreshes. A
non-refreshing access-only snapshot can establish worker protocol compatibility,
but cannot qualify the authority's renewal lifecycle.

```yaml
apiVersion: paseo-gateway.manziman.github.io/v1alpha1
kind: PaseoCredentialProfile
metadata:
  name: codex-workers
  namespace: paseo-system
spec:
  env: []
  files: []
  codexSubscription:
    authSecretRef: {name: codex-authority, key: auth.json}
    outputSecretName: codex-worker-access
```

Import the dedicated file through your secret manager or `kubectl create secret
--from-file`; never place its contents in YAML, command arguments, CRs or logs.
The authority and output Secret names must differ. Do not precreate the output
Secret. One profile owns one authority Secret; multiple profiles cannot claim it.
The state key `paseo-access.json` is reserved and cannot be the input auth key.

Only the gateway ServiceAccount needs read/write authority-Secret access. The
workspace ServiceAccount remains without Kubernetes API access. Allow gateway egress to cluster DNS, the Kubernetes API and the provider HTTPS endpoints; an external namespace policy must permit those paths. Restrict Secret,
profile and Pod administration: an administrator able to create arbitrary Pods or
project arbitrary Secrets can bypass a profile-level boundary. Enable cluster
Secret encryption and scope namespace access. Do not expose authority Secret data
through diagnostics, backups without encryption, or public qualification evidence.

Workers mount a whole read-only Secret volume containing **access token, account
ID, optional plan type and expiry only** at `/run/paseo-codex/access.json`. No refresh
token or native auth file is delivered. Kubernetes updates the mount eventually;
there is no `subPath` or persistent-home copy. Subscription profiles cannot mix API
key, access-token or workload-identity environment authentication. Direct native
CLI execution using this profile is not supported by the bridge; use Paseo's
app-server integration. Non-subscription profiles retain ordinary CLI behavior.

## Moving the authority between clusters

After the first successful renewal, the Kubernetes authority Secret contains the
current managed login; the original local bootstrap file is stale. Never reimport
that file or duplicate the login into another running authority.

Kubernetes resourceVersion leases coordinate only within one cluster. They cannot
prevent two clusters from refreshing copied credentials. To migrate, stop the
source gateway and any native authority process first, confirm no unfinished
refresh intent remains, and transfer only the latest committed authority state
through an encrypted, operator-controlled Secret workflow. Keep the source stopped
before activating the target. Do not transfer an ambiguous unfinished rotation;
recover with a new dedicated login instead. An independently created dedicated
login for the target is also an alternative to migrating state. Validate the target
profile's ownership and bootstrap procedure before enabling workers; never run both
brokers against copies of the same refresh credential.

## Concurrency, failure and recovery

A Kubernetes resourceVersion compare-and-swap claims a 60-second lease on the
**authority Secret before invoking native Codex**. A durable refresh-intent hashes
the actual refresh credential, so reformatting auth JSON cannot unlock a failed
rotation. Concurrent workers/gateways cannot rotate the same Secret independently.
Native execution has a 30-second deadline. A stale completion cannot overwrite a
new bootstrap or publish after losing its lease. Successful native auth state is
committed first, then access-only output is published. A restart between those
writes reconstructs output from committed state without another refresh.

There is no atomic transaction between provider OAuth rotation and Kubernetes.
If native execution or the durable commit is uncertain, the broker **does not
retry** that refresh credential. An expired unfinished intent reports
`CodexReauthenticationRequired`; the operator supplies a genuinely new dedicated
login. This trades automatic recovery of an ambiguous rotation for avoiding
refresh-token reuse. It is an explicit remaining operational limitation, not a
claim of lossless token renewal under every crash.

Renewal starts five minutes before access expiry. A normal same-identity renewal
can keep its still-valid access projection while the authority runs. Changed
bootstrap/configuration invalidates old output first. Fenced uncertain attempts
invalidate output after lease expiry. Volume propagation remains eventual. Native
refresh errors, invalid exports, write conflicts and expiry return fixed redacted
reason codes; no exception body or account identity is logged.

On an authorization error, the worker waits up to eight seconds for a different
access token for the **same account**. It never independently refreshes or switches
accounts. If the gateway has no replacement, the callback fails with an actionable
redacted error; it cannot extend expiry. A changed identity requires recreating
idle workers. Revoke credentials at the provider when necessary; deleting a
Kubernetes Secret cannot revoke an access token already loaded into a process.

## Evidence and outstanding acceptance

On 2026-09-24, both candidate images passed the pinned native protocol contract
with networking disabled, a read-only root filesystem, a 64 MiB temporary volume
and a nonempty system CA bundle. A dedicated subscription login then completed an
actual native authority refresh in Kubernetes. Two isolated workers concurrently
completed real provider prompts that read distinct per-agent environment values.
Their histories remained independent. Both Pods had Kubernetes API token mounting
disabled, no authority Secret reference and no persisted refresh credential.

Advancing only the cached access-expiry metadata caused another real native
refresh. Updated access-only projections reached both existing Pods without
restarts; fresh agents in each Pod completed provider prompts using the replacement.
Replacing the gateway then preserved all four completed histories byte-for-byte,
both worker Pod UIDs and the committed authority credential. The new gateway reused
durable auth state without another refresh. A separate bounded prompt was observed
running a tool before gateway replacement; after reconnection, the same turn
completed with one original user prompt and tool call and unchanged worker Pod
UIDs. These results demonstrate early renewal and gateway recovery during idle and
active turns, not actual provider expiry or worker Pod failure.

Unit tests additionally cover concurrent authorities, lease expiry, ambiguous
refresh failure, commit conflict, bootstrap replacement, reformatting bypass
attempts, access-only projection, external login ordering and replacement-access
callbacks. Actual expiry/revocation, explicit credential replacement and worker Pod failure
during a turn remain unqualified; keep those acceptance gates open. See the
[local qualification report](local-parity-qualification.md) for candidate digests
and the [provider harness](provider-acceptance.md) for reproducible procedures.
