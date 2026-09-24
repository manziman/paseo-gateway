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

## GitHub App live renewal

First run the existing private repository acceptance workflow with an App-backed
profile. This establishes clone, commit, push and draft-PR behavior with an
installation token. Select that **disposable running workspace** in a private
configuration:

```json
{"context":"docker-desktop","namespace":"provider-acceptance","workspace":"SELECT_TEST_WORKSPACE","forceRenewal":true,"timeoutSeconds":240}
```

Run `node --import tsx scripts/github-app-live.ts CONFIG.json REPORT.json`.
It verifies the token's repository allowlist and Git access, advances the output
Secret's renewal metadata, observes a different live-minted token reaching the
same running Pod, and checks subsequent Git/gh calls without restart. The private
key stays in the gateway. This is an actual mint/renew test, but **not an actual
expiry test**: metadata is advanced before the provider's real expiry. The report
keeps actual expiry/revocation and separate push/PR evidence explicitly blocked.
Never present a mocked HTTP renewal or a static token test as App renewal evidence.

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
