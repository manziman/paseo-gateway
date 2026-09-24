# Provider credential acceptance

Provider binaries being installed does not establish successful authentication or
renewal. Run each selected credential profile independently. Never copy ambient
workstation credentials into tests, and never print tokens, private repository
names, cluster names or account IDs in public evidence.

## Concurrent provider prompts

Prepare explicit projects/profiles using operator-selected credentials. Keep this
configuration in a private local file; it is not a checked-in deployment example:

```json
{
  "context": "docker-desktop",
  "namespace": "provider-acceptance",
  "tls": {"caFile": "/secure/gateway-ca.crt", "serverName": "localhost"},
  "replaceGateway": false,
  "cases": [
    {"provider": "claude", "authentication": "claude-setup-token", "project": "claude-test", "mode": "bypassPermissions"},
    {"provider": "codex", "authentication": "codex-subscription-authority", "project": "codex-test", "mode": "full-access"},
    {"provider": "opencode", "authentication": "opencode-config"}
  ]
}
```

Run `node --import tsx scripts/provider-live.ts CONFIG.json REPORT.json`.
The context is mandatory; the current kubectl context is never used implicitly.
TLS uses the selected CA and validates the selected server name over loopback
port-forwarding. It never disables certificate verification. Omit `tls` only for
an intentionally plaintext local chart. `identitySecret` defaults to
`paseo-identity` and may be selected explicitly.

Each configured case creates two isolated workers, asks the real provider to read
an agent-specific environment sentinel, checks independent assistant histories,
and refreshes provider discovery. The sentinel is never included in the prompt,
so a successful reply requires environment delivery. Runtime versions and image
digests are observed from the actual Pods; the report separately records gateway
image digests. Select `replaceGateway: true` only in a
disposable acceptance namespace to additionally verify completed history recovery
and one original prompt across gateway replacement. This check is not evidence of
active-turn recovery; that remains separately reported. Select
`activeTurnGatewayRecovery: true` for a separate bounded tool-running prompt: the
harness observes an active tool, replaces only the gateway, reconnects and requires
the original prompt/tool call once and the completed reply. This qualifies gateway
interruption during a turn, not worker Pod failure during a turn.

A missing project is `blocked`, never passed. Errors are redacted. The report
contains no context, namespace, project, agent or credential identity. A separate
`REPORT.json.cleanup-private.json` records resource names and must not be published.
Tests request suspension of only their own workspaces in `finally`; volumes and
histories remain for inspection. Set `retainRunning: true` only when an explicit
follow-up inspection needs live Pods, then suspend those recorded workspaces after
inspection. Exit codes: `0` all checks passed, `1` failure,
`2` at least one blocked gate. Do not erase blocked rows when publishing evidence.
This harness deliberately reports actual expiry/revocation, credential replacement
and active-turn injection as blocked until their distinct evidence is collected.

A Codex subscription case requires `spec.codexSubscription`; an API-key profile is
not accepted as a substitute. See [authority bootstrap](codex-subscription-authority.md).
Set `renewCodexAuthority: true` to request a real native renewal after concurrent
prompts: the harness advances only the authority's cached access-expiry metadata,
requires committed native auth and worker access to change, verifies updated
projections in the same Pods, then completes fresh-agent prompts in both workers.
This option uses the selected dedicated authority and must never target a login
still refreshed by another client. It demonstrates early renewal, not actual
provider-side expiry. Combined with `replaceGateway: true`, it also checks durable
authority reuse across gateway replacement. The Kubernetes authority Secret is
authoritative after renewal; do not reimport the stale bootstrap file.

Run API-key qualification as its own `codex-api-key` case. OpenCode requires a
profile with the intended provider's explicit configuration and credentials; use
`model` to select the configured provider/model if required.

## Generated-invalid rejection and recovery

`node --import tsx scripts/provider-failure-live.ts PRIVATE_CONFIG.json REPORT.json`
uses an explicit context and namespace and creates one isolated project, profile,
Secret, workspace, and PVC. The private config selects `provider` (`claude` or
`opencode`), its matching `credentialEnv`, `tls`, and `identitySecret`. OpenCode
also needs `providerConfigFile` and `model`. Set `invalidOnly: true` to create a
random invalid credential without reading a valid one; restore checks are
`skipped` because that mode does not select them. For full recovery, supply an explicitly authorized
`validCredentialFile`. Keep config, report, and the separate cleanup inventory
outside the repository.

The generated credential must produce a bounded, visible authentication failure
without a successful assistant reply. Pinned Paseo 0.9.1 may report this as an
`idle` turn whose assistant message contains the authentication error; the
harness records that exact surface instead of claiming a structured terminal
error. Full recovery replaces only the fixture Secret with the existing valid
credential, checks that the old Pod still rejects it, then suspends/resumes the
workspace and requires a successful fresh agent with a new Pod UID and retained
PVC. Finally it suspends the workspace and resets the fixture Secret to the
generated invalid value. This proves invalid-credential rejection and
invalid-to-existing-valid replacement recovery. Actual provider expiry/revocation
and rotation between two independently valid keys are reported as `skipped`
unless separately selected and tested; neither is implied by this result.

## GitHub App live renewal

Select a **disposable running workspace** using an App-backed profile in a private
configuration. Create the workspace through the normal CLI/SDK with its configured
TLS trust, then run the in-Pod Git/API harness:

```json
{
  "context": "docker-desktop",
  "namespace": "provider-acceptance",
  "workspace": "SELECT_TEST_WORKSPACE",
  "forceRenewal": true,
  "timeoutSeconds": 240,
  "privateWrite": {"repository": "owner/disposable-repository"},
  "revokeNewlyMintedToken": true,
  "suspendAfter": true
}
```

Run `node --import tsx scripts/github-app-live.ts CONFIG.json REPORT.json`.
Writes and revocation are disabled unless explicitly selected. `privateWrite`
requires the selected repository to match both the profile allowlist and the
workspace's HTTPS origin. It creates a unique branch, commits only a generated
marker with the projected identity, pushes and opens a draft PR. Git hooks are
disabled for these deterministic acceptance commands. Private branch/PR/resource
identities go only into `REPORT.json.cleanup-private.json`, never public evidence.
The PR remains draft and unmerged for operator inspection.

The harness verifies repository scope and absence of the App private key and
Kubernetes API token in the worker, requests early renewal, observes a different
live-minted token reaching the same running Pod, and checks subsequent Git/gh calls
without restart. Advancing expiry metadata is an actual mint/renew test, not an
actual elapsed-time expiry test.

When `revokeNewlyMintedToken` is selected, the harness requires the fixture to be
the profile's sole running consumer. It revokes only the newly minted token using
GitHub's [installation token revocation endpoint](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token),
requires HTTP 401 and failed Git access, requests a new mint and verifies recovery
in the same Pod. It never deletes the App installation or revokes the App key.
Recovery here follows an explicit renewal request; it does not establish automatic
renewal triggered by a worker's 401. Actual elapsed-time expiry remains separately
reported as skipped. Actual revocation plus successful renewal/replacement qualifies
the selected rejection/recovery case without claiming elapsed-time expiry. Never present mocked HTTP renewal, synthetic invalid tokens
or a static token test as evidence of real App renewal/revocation.

## Replacement, rejection and recovery procedures

For Claude setup tokens, supply a second explicitly selected token and update only
the test Secret. Existing environment-based Pods retain their original value.
Complete an idle worker's first prompt, suspend/resume it, then complete a second
prompt and verify both original user messages occur once. Test an independently
selected invalid/revoked credential in a separate profile and require a bounded,
observable failure. Do not revoke a user's working account credential to create
this fixture. Env and ordinary `subPath` configuration refresh require Pod
recreation; Git/App and Codex access-only whole volumes update eventually.

For Codex, use a dedicated login with no other refresh consumers. Observe one
native authority renewal under two active workers, replace the gateway, and verify
worker histories and committed auth state recover without replay. A failed or
ambiguous refresh must report reauthentication, not loop through old refresh
credentials. An access-only snapshot test proves the worker bridge but not this
lifecycle. Do not exercise destructive refresh/revocation against an active local
login cache.

For App rejection, use a disposable App installation or separately revoked fixture
selected by the operator. Confirm renewal fails with a redacted status and does
not broaden repository permissions. Waiting for real access expiry is a separate
gate from requesting early renewal. Complete native/provider fault injection
before claiming #57/full parity; missing credentials remain a reported blocker.
