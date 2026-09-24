# Credential renewal

## GitHub App installation tokens

The gateway can renew GitHub App installation access tokens. The broker
does not project the App private key into workspace Pods; only the gateway mints
installation tokens. Configure a profile:

```yaml
spec:
  env: []
  files: []
  git:
    githubApp:
      appId: 123456
      installationId: 654321
      privateKeySecretRef: {name: github-app-key, key: pem}
      outputSecretName: github-installation-token
      repositories: [organization/repository]
```

The allowlist is required, contains `owner/repository` names, and must belong to one
owner. Projects using the profile must target one of these repositories on
`github.com`. The App installation must grant repository contents and pull-request
write permissions. Enterprise-hosted App endpoints are not implemented. Do not
precreate the output Secret; the broker creates and owns it and refuses to adopt
unrelated Secrets. A static `git.tokenSecretRef` and `git.githubApp` are mutually
exclusive. Neither profile fields nor broker status contain credentials.

The broker signs an RS256 JWT using the referenced RSA key, requests only the
allowlisted repositories with `contents: write` and `pull_requests: write`, verifies
the returned repository scope, and writes only the access token into its output
Secret. JWTs last nine minutes with a one-minute clock-skew allowance. GitHub
installation tokens normally expire after one hour; renewal begins five minutes
before the returned expiry. See GitHub's [JWT requirements](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
and [installation token contract](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

Before calling GitHub, the broker atomically claims a 60-second lease in output
Secret annotations with Kubernetes resourceVersion compare-and-swap. Another
replica cannot claim an active lease. Requests time out after 15 seconds, and a
writer that loses its lease cannot publish. A crashed broker's lease expires.
Synchronize node clocks. Failed renewal preserves the previous token until its
normal expiry, except that a changed configuration writes an empty token key
before requesting the new scope. Keeping the key present lets Kubernetes update
the volume to an empty file instead of retaining a previous successful projection.
This is subject to volume propagation delay, not immediate remote revocation. Failed attempts back off exponentially from five seconds
to five minutes, with retry times persisted across gateway restarts.

`BrokerStatus` reports profile name, state, a sanitized reason, and next attempt.
Output Secret annotations carry expiry, retry, and lease metadata. Do not log
Secret bodies, JWTs, access tokens, private keys, or raw HTTP exceptions. A 403 or
401 remains an observable failed renewal; the broker does not broaden privileges
or fall back to another credential. Renewals currently have mocked HTTP coverage;
live App minting has not been tested because no App credentials were provided.
The separate successful private HTTPS clone/push/draft-PR test validates the static
Git token and `gh` path; it does not validate App minting or expiry recovery.

## Reading updated tokens without restarting Pods

Both static Git tokens and broker output tokens mount as a whole read-only Secret
volume at `/run/paseo-git`. They do not use environment-variable values or `subPath`
mounts. Each Git credential-helper invocation opens the current token file. The
`gh` wrapper similarly loads the current file and supplies `GH_TOKEN` or
`GH_ENTERPRISE_TOKEN` only to its `/usr/bin/gh` child process. No token is stored in
the persistent home, Git URL, or Git configuration.

Kubernetes eventually updates mounted Secret volumes. Rotation is not instantaneous;
renewal lead time accommodates normal propagation. A command already running keeps
its initial credential until it exits. Expired tokens are rejected by GitHub; the
wrapper does not extend their lifetime. Deleting the profile or its Secret is not
a substitute for revoking an already-issued token with the provider. Invoking `/usr/bin/gh` directly bypasses the
wrapper; use `gh` from the image's normal PATH. [Kubernetes documents Secret volume
propagation and the lack of updates for subPath mounts](https://kubernetes.io/docs/concepts/configuration/secret/).

## Codex subscription authentication

A pinned native Codex authority and access-only worker bridge are implemented;
see the [subscription authority decision, setup and failure contract](codex-subscription-authority.md).
The gateway invokes Codex's own managed refresh and never implements a private
OAuth endpoint. Workers use the documented experimental external-token app-server
mode and do not receive refresh tokens. Shared `.codex/auth.json` projections and
`CODEX_HOME` overrides remain prohibited.

Two concurrent Kubernetes workers using a dedicated login have live evidence for
actual native renewal, updated access delivery without Pod replacement and gateway
replacement during idle and active turns without prompt replay. Actual
expiry/revocation, explicit credential replacement and worker Pod failure during a
turn remain unqualified.
API-key success is a separate case and does not close subscription parity.
An uncertain external refresh is deliberately fenced until a new login is supplied;
it is not silently retried. See [provider acceptance](provider-acceptance.md) for
executed versus blocked reporting and rotation procedures.

OpenAI also documents administrator-managed access tokens and workload identity
federation. Those are separate integrations, not substitutes for a personal
subscription's rotating login. See [authentication](https://learn.chatgpt.com/docs/auth)
and [workload identity federation](https://developers.openai.com/api/docs/guides/workload-identity-federation).
