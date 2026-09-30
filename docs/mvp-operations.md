# Headless MVP operations

This deployment is one TypeScript gateway/controller with isolated upstream
Paseo daemons. Kubernetes is the workspace lifecycle authority. It is an
independent project, not an official Paseo service.

## Install and connect

Follow the README local prerequisites. Use a fresh namespace for a new installation:

```sh
PASEO_NAMESPACE=paseo-mvp npm run dev:up
PASEO_NAMESPACE=paseo-mvp npm run credentials -- /absolute/path/to/claude-token
PASEO_NAMESPACE=paseo-mvp PASEO_LOCAL_PORT=6769 npm run dev:connect
```

Import `paseo-identity`'s password into your shell only, then use the pinned
upstream CLI with `--host 127.0.0.1:6769` (or `tcp://127.0.0.1:6769`). The SDK
uses `ws://127.0.0.1:6769/ws`; these target formats differ. Keep the password out of shell arguments,
committed configuration and logs. Both the CLI and SDK remain upstream packages.
Use `paseo --host ... run --new-workspace worktree --cwd /projects/<project>` to
allocate cluster compute, or `--workspace <id>` to explicitly reuse it. Create
projects and credential profiles through the namespaced Kubernetes API.

The worker image pins Paseo 0.9.1, Claude Code 2.1.274, Codex 0.156.1 and OpenCode
1.18.32. Installing a binary does not authenticate it. See
[credential profiles](credential-profiles.md) and
[credential renewal](credential-renewal.md) for supported credentials and the
remaining shared Codex subscription limitation. Add custom toolchains through
per-project or per-profile image overrides.

## In-pod orchestration

The worker's `paseo` entry point reads a short-lived bearer from a projected
Secret on every invocation and connects to the gateway Service. A plain `run`
creates an isolated sibling workspace; explicit `--workspace` reuses one.
Tokens authorize only the configured project and credential profile. They are
renewed by the controller, and expire or become invalid when their origin
workspace stops Running or its UID changes. The owner password and Kubernetes
service-account token are not projected into worker pods. The upstream daemon
still needs its own backend credential; NetworkPolicy enforcement is required
for cross-pod isolation. This is a trusted-owner deployment, not hostile
multi-tenant isolation. See [networking](networking.md).

Built-in local workspace-spawning MCP tools remain disabled. Use the in-pod CLI
for cluster-authoritative sibling creation. Arbitrary shell access can still
invoke the underlying daemon binary; the CLI adapter is a routing convenience,
not a security sandbox for untrusted code.

## Schedules and capacity

See [schedules](schedules.md) for the upstream CLI and durable run semantics.
Each run gets a new workspace. Completed scheduled workspaces are archived after
teardown and retain their PVC for 24 hours by default. A run with unknown dispatch
outcome blocks `Forbid` until an operator inspects it; there is no automatic
mutation replay. Default namespace capacity is 20 running workspaces
(`gateway.maxRunningWorkspaces`), with optional project `maxRunningWorkspaces`.
Rejected API creates fail promptly; directly created CRs wait for capacity in
Pending state. Resource requests/limits come from the profile/project.

Cold-start readiness waits default to five minutes. Configure
`gateway.workspaceReadyTimeoutSeconds` (1–3600; environment variable
`WORKSPACE_READY_TIMEOUT_SECONDS`) for larger repositories. Creation snapshots
let the upstream CLI observe progress without its legacy 60-second RPC deadline.
A timeout or interrupted mutation is explicit; inspect its workspace and durable
creation record before submitting a new key.

## Archive, retention and diagnostics

Manual workspace storage is retained indefinitely unless its explicit policy
sets `ttlAfterArchivedSeconds`. `storage: Ephemeral` uses emptyDir and cannot
suspend or recover a lost pod. Archived residency is terminal. Teardown runs
before compute stops or a volume is released; failed or ambiguous hooks preserve
data and require inspection. Never automatically remove a teardown intent marker
just to make a test pass. See the marker recovery procedure in
[operations](operations.md).

Agent directory metadata is captured before archive. Timelines remain on the PVC;
offline metadata is not a claim that an archived agent is running. TTL collection
waits for owned PVC deletion to complete, then removes cached inventory. An
unavailable suspended workspace is reported explicitly instead of silently
omitting its agents.

`storageDeletedAt` records completion of PVC deletion, not a forensic erasure
guarantee. Use a StorageClass/PV with `Delete` reclaim policy when retention must
also release its backing storage; `Retain` leaves the data for administrative
cleanup. This follows [Kubernetes volume reclamation](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#reclaiming).
Apply separate retention to storage snapshots/backups and schedule history.

Authenticated `GET /workspaces/<id>/status` reports lifecycle and durable failure
reasons, including OOMKilled and unschedulable pods. `GET
/workspaces/<id>/logs?tail=100` returns bounded daemon logs (maximum 1000 lines,
64 KiB). Role-scoped callers can read only authorized workspace diagnostics.
Provider logs may contain sensitive task content; protect this endpoint as you
protect the provider session itself. Health and readiness endpoints contain no
credentials. Gateway event logs do not serialize request bodies or Secrets.

Host recycling, host password changes and nightly host reboot operations are
intentionally replaced by Kubernetes deployment/pod lifecycle. Do not force-delete
a partitioned pod and assume RWO guarantees single-writer fencing. EKS deployment
requires storage/CNI/node-loss validation beyond Docker Desktop functional tests.

## Acceptance

```sh
npm run check
npm run test:cli
npm run test:upstream
PASEO_NAMESPACE=paseo-mvp npm run test:live
PASEO_NAMESPACE=paseo-mvp RUN_CLAUDE_LIVE=1 npm run test:live
PASEO_NAMESPACE=paseo-mvp npm run test:lifecycle
PASEO_NAMESPACE=paseo-mvp PASEO_TEST_WORKSPACE=<running-test-workspace> npm run test:auth
node --import tsx scripts/test-crd-validation.ts paseo-mvp
```

Private acceptance deliberately writes external test artifacts. First import an
SSH key/strict known-hosts source or Git token and a PR-capable GitHub token into
an authorized credential profile. Configure a disposable project and repository.
Then run:

```sh
PASEO_NAMESPACE=paseo-mvp RUN_PRIVATE_LIVE=1 \
  PASEO_TEST_PROJECT=private-test PASEO_TEST_REPOSITORY=owner/test-repo \
  npm run test:private
```

It creates a dedicated branch, a harmless marker commit and draft PR, then asks a
real Claude orchestrator to spawn and wait for an isolated worker through the
in-pod CLI. A schedule then starts another orchestrator whose worker creates a
second marker branch and draft PR. The test checks the pushed commit and draft
state. It attempts to pause its schedule on success or failure and retains test
workspaces/PRs for inspection. `PASEO_TEST_WORKSPACE=<existing-test-workspace>`
skips the initial clone/push/PR stage when resuming workflow checks; scheduled
worker testing still creates a new draft PR. Inspect any previous uncertain
creation before rerunning, since each invocation uses new test identifiers.
The repository's default branch must be `main` for this fixture. Tests do not
publish application changes or merge the PR. See [MVP plan](mvp-plan.md) and
[compatibility evidence](compatibility.md) for current release gates.

The lifecycle fixture creates only its own workspaces and tests retained and
ephemeral storage. It temporarily holds its own PVC with a finalizer to verify
that TTL collection waits for actual deletion. Its cleanup removes only that
test finalizer; other namespaces and volumes remain untouched.

The authentication fixture mints short-lived scoped credentials in memory and
checks project visibility, mint denial, socket expiry and expired-token rejection.
It does not change the selected workspace or make provider calls. Its cross-scope
diagnostic check requires another project/profile workspace in the namespace and
prints an explicit skip when none exists.

To verify an existing authorized PR without creating remote artifacts, use
`PASEO_NAMESPACE=paseo-mvp PASEO_TEST_PROJECT=private-test PASEO_TEST_PR=123 npm run test:checkout`.
It compares the checkout with the remote PR ref, archives twice, verifies retained
storage and unchanged existing agent inventory, and leaves its archived PVC for
inspection. It does not invoke a provider or push repository changes.

For the local live, authentication, and PR-checkout harnesses, verified gateway TLS
is selected by setting both `PASEO_TEST_CA_FILE` (the operator's CA PEM path) and
`PASEO_TEST_TLS_SERVER_NAME` (the certificate DNS name). Their loopback port-forward
then uses HTTPS/WSS with certificate and hostname verification; a TLS failure does
not retry plaintext. Omit both only for an existing plaintext loopback test
installation. `PASEO_IDENTITY_SECRET` selects the gateway identity Secret (default
`paseo-identity`). These options do not change the Docker Desktop context or select
provider credentials. Do not print trust/identity configuration alongside reports.
