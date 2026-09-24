# Credential profiles and workspace runtimes

`PaseoCredentialProfile` is a namespaced CRD. Projects select a profile through
`spec.credentialProfile`; each workspace retains its selected profile reference.
Profiles contain Secret and ConfigMap **references**, never token values or private
keys. Referenced objects must exist in the workspace namespace. The controller
checks each referenced key before creating compute and reports missing references
without including their contents.

See [the example profile](../examples/credential-profile.yaml); replace its `paseo`
namespace with your installation namespace. Create its Secret and ConfigMap
objects separately using your normal secret-management process.
Neither the example nor any CR should contain actual credentials. Users allowed to
edit profiles can grant workspace processes access to namespace-local credentials;
restrict profile, project, and Secret administration accordingly. Processes and
repository hooks inside a workspace can read that workspace's mounted credentials.
Profiles are an operator configuration boundary, not a sandbox for hostile tenants;
see [network and namespace trust](networking.md#trust-boundary).

## Environment and file projections

`spec.env` accepts up to 64 unique `{name, valueFrom}` entries. `valueFrom` must
contain exactly one `secretKeyRef` or `configMapKeyRef`, each with `name` and `key`.
For example, use `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, or
provider-specific configuration variables. Values are resolved by Kubernetes in
both the checkout container and daemon; the gateway never renders them into Pods.
Runtime variables such as `HOME`, `PATH`, `PASEO_*`, `GIT_*`, `NODE_*`, and loader
variables are reserved.

`spec.files` accepts up to 32 `{path, valueFrom, mode?}` entries. Paths are relative
to the workspace home (`/home/paseo` in the daemon and `/data/home` in checkout).
Use `.config/opencode/opencode.json`, for example. Paths cannot be absolute,
traverse parents, overlap another projected file, or replace gateway configuration,
global Git credentials, or shell startup files. Modes are decimal `288` (`0440`,
default) or `292` (`0444`). Files mount read-only; their contents are not copied to
the persistent volume. Ordinary writable provider state belongs in the workspace's
private home.

Read-only projected files are appropriate for immutable configuration and API-key
credentials. They are **not a refresh/writeback mechanism for rotating OAuth login
files**. Do not share a rotating CLI login file across workspaces on the assumption
that refreshes will be synchronized. That credential lifecycle is independent of
this profile feature. In particular, shared `.codex/auth.json` projections are rejected;
see the explicit [subscription-authentication boundary](credential-renewal.md).
Environment and `subPath` file updates require Pod recreation to take effect; suspend and resume the workspace after rotating these credentials.
Kubernetes documents these constraints for [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
and [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/).

For compatibility, if no `PaseoCredentialProfile` exists with the selected name,
the controller treats that name as a legacy Secret whose `token` key supplies
`CLAUDE_CODE_OAUTH_TOKEN`. An existing profile with invalid/missing references fails
instead of falling back. Migrate by creating the namesake profile with explicit
`env` references, then recreating the workspace Pod.

## Private Git and GitHub

HTTPS repositories must use a credential-free URL such as
`https://github.com/organization/repository.git`. Set `git.tokenSecretRef` to the
Secret key containing a scoped access token. `git.username` defaults to
`x-access-token`. Tokens use a whole Secret volume, reopened on each invocation;
see [renewal behavior](credential-renewal.md). The runtime's credential helper
answers only HTTPS requests for the exact configured repository host and path. It implements only credential
retrieval, never storage. Git receives the token over its helper protocol; it is
not added to repository URLs, command arguments, CRs, generated manifests, or Git
configuration files. Checkout captures command output and emits sanitized failure
messages. The same configuration supports fetch and push from the running daemon.
See Git's [credential helper protocol](https://git-scm.com/docs/gitcredentials).

The `gh` wrapper reads the current projected token for each invocation and supplies
`GH_TOKEN` for github.com, or `GH_ENTERPRISE_TOKEN` for a custom GitHub host, only to
its child process, with `GH_HOST` set from the repository. This enables `gh` without
writing a login token to the home directory. Supply appropriate repository and PR
permissions; granting a read-only token does not grant push access. Profiles that
manage `git.tokenSecretRef` or `git.githubApp` cannot also override these `gh`
environment variables.
For SSH-only Git, supply `GH_TOKEN` separately through `env` if GitHub API operations
are required.

SSH URLs may use `git@github.com:organization/repository.git` or
`ssh://git@github.com/organization/repository.git`; the SSH username must be `git`.
Set `git.ssh.keySecretRef` and `git.ssh.knownHostsRef` (the latter is one Secret or
ConfigMap key reference). Both are projected into `/run/paseo-ssh`. The runtime
uses a fixed `GIT_SSH_COMMAND` with `IdentitiesOnly=yes`, `BatchMode=yes`, and
`StrictHostKeyChecking=yes`; there is no automatic host-key acceptance. Obtain the
host key from a trusted published fingerprint or your administrator before
creating the known-hosts object. Unencrypted deploy keys support unattended use;
interactive passphrase prompting and SSH-agent forwarding are not implemented.

`git.identity` sets Git `user.name` and `user.email`. Optional
`git.signing: {format: ssh, keySecretRef: {name, key}}` mounts a signing key and
enables signed commits and annotated tags. Register the matching public signing
key with GitHub for verification. Identity/signing apply to both initialization
and agent commands through Git's environment configuration; private keys remain
in Secret-backed read-only volumes.

## Images and resources

The shipped image installs pinned provider CLIs; consult the workspace Dockerfile
and [runtime compatibility matrix](upstream-parity.md) for exact supported versions.
`spec.runtime.image` on a profile selects a custom image. A project's
`spec.runtime.image` takes precedence, followed by the profile and chart default.
Both checkout and daemon use the selected image. Pin production images by digest.
A compatible custom image must provide Node 24, Git, `gh`, OpenSSH tools, the
Paseo-compatible daemon entrypoint on port 6767, and the runtime helpers. Extend
the shipped workspace image to preserve initialization, teardown,
`git-credential.mjs`, `token-file.mjs`, the `/usr/local/bin/gh` wrapper, and the
`/opt/paseo/bin/paseo` CLI shim with `cli-target.mjs`. Replacing these helpers can
bypass live token loading or gateway-scoped worker routing. The image must run as
UID/GID 1000 with a read-only root filesystem and writable home, workspace, and
`/tmp` mounts. Preserve the upstream daemon wire contract when replacing images.

Profile/project `runtime.resources.requests` and `.limits` support `cpu`, `memory`,
and `ephemeral-storage`. Project values override individual profile values, which
override daemon defaults. Checkout retains its bounded initialization allocation.
Namespace quotas/LimitRanges still apply. Changing a runtime selection requires
Pod recreation; existing Pods are not mutated in place.

## Initial checkout

Workspace `revision` selects the initial base revision. `branch`, when present,
creates or selects a local branch after fetching that revision. `pullRequest`
selects GitHub's `refs/pull/<number>/head` instead of the base revision, and may be
combined with `branch` to make a local working branch. `fetchDepth` defaults to
`1`; use `0` for full history or an integer up to `100000` for bounded history.
The checkout-ready marker prevents subsequent Pod restarts from resetting local
commits or dirty files. Interrupted initial fetches retry safely, and a mismatched
existing origin is rejected. Submodules are not recursively fetched. Branch and
revision settings are initialization choices, not instructions to reset resumed
workspaces.
