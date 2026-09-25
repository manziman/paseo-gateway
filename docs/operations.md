# Operations

## API-group transition

The API group and custom label prefix are `paseo-gateway.manziman.github.io`,
scoped to the repository owner’s GitHub namespace. These identifiers do not
claim ownership of an upstream domain or imply upstream endorsement.

The first local POC used a different API group. That running installation
cannot be upgraded in place simply by applying the new CRDs: new records get
new Kubernetes UIDs, while PVC names and ownership depend on the original UIDs.
`dev:up` refuses to replace the gateway when it finds project/workspace records
from a different API group in `paseo-system`.

Keep the existing deployment and volumes until you have exported its records,
backed up its identity/profile Secrets and PVC contents, and stopped its
workspace compute using the old API group. Do not delete old CRDs, namespaces,
or PVCs as a migration shortcut. For a separate fresh installation, use a new
namespace with the new chart and separately provisioned Secrets. Recreate
project/workspace records under the new group and restore data from verified
backups while compute is stopped. This POC has no automated cross-group data
migration or PVC adoption. Keep the old installation available until restoration
and any changed workspace paths/IDs have been verified.

Local convenience scripts default to `paseo-system`. Set `PASEO_NAMESPACE` for
all commands in a separate installation; each namespace gets its own identity,
credentials, controller and workspace catalog. `dev:up` checks for incompatible
API groups in the selected namespace before changing resources. For example:

```sh
export PASEO_NAMESPACE=paseo-validation
npm run dev:up
npm run credentials -- /absolute/path/to/claude-token
RUN_CLAUDE_LIVE=1 npm run test:live
PASEO_LOCAL_PORT=6769 npm run dev:connect
```

Use the selected namespace in manual `kubectl -n` commands too. Namespace names
follow the [Kubernetes namespace rules](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/).
This creates a fresh catalog; it does not migrate old workspaces or their data.
Changing the code in Git does not change the existing running cluster.

## Lifecycle and recovery

Local examples always name the Docker Desktop context and `paseo-system`
namespace. Change an individual workspace's residency to stop or resume compute:

```sh
kubectl --context docker-desktop -n paseo-system patch paseoworkspaces.paseo-gateway.manziman.github.io WORKSPACE \
  --type merge -p '{"spec":{"residency":"Suspended"}}'
kubectl --context docker-desktop -n paseo-system patch paseoworkspaces.paseo-gateway.manziman.github.io WORKSPACE \
  --type merge -p '{"spec":{"residency":"Running"}}'
```

Archive through the desktop or set residency to `Archived`. Both run teardown and
stop compute. The default retains the record and PVC; an explicit storage TTL
allows the controller to collect the PVC after archival. Explicitly deleting a
workspace record retains its PVC; its Pod, Service and access Secret are
garbage-collected. Record the old PVC name
and back up data before deleting records. Automatic adoption/restoration of an
orphan PVC is not implemented. A newly created record gets a new volume.

Deleting a PVC or namespace can destroy retained storage. The controller deletes
only owned PVCs whose configured archive retention deadline has expired; it never
deletes namespaces. Helm uninstall retains CRDs, custom records, manually provisioned
Secrets and PVCs, but also stops reconciliation; suspend workspaces before
uninstalling to stop their compute. Local development does not include a
destructive `down` command.

Gateway replacement disconnects clients while agents keep running. A request
whose response is lost may have executed. Inspect agent history before retrying;
no mutation is automatically replayed. Reconnect creates a new directory
generation and fetches full snapshots. Ordinary backend RPCs time out after
55 seconds. The read-only `wait_for_finish_request` instead honors its requested
timeout plus five seconds for delivery; an omitted/nonpositive timeout waits
until completion or connection closure, matching the pinned upstream contract.
This does not extend mutation deadlines or enable replay.
Workspace pod replacement can interrupt
an active turn even though files and provider history survive.

The checkout init container retries only recognized transient Git DNS, network,
and timeout failures, at most three fetch attempts within a 150-second **Pod-wide**
budget. A receipt in an init-only, Pod-local `checkout-budget` emptyDir preserves
the original deadline, consumed attempts, and retry backoff across
checkout-container restarts. The initializer creates a private owner-only
directory under `/run/paseo-checkout`; the daemon cannot mount that volume. Each
attempt is recorded before Git starts. Permanent failures and exhausted budgets
are latched: kubelet may restart the failed init container under the unchanged
`Always` policy, but it reports the same safe failure without fetching again.
Malformed receipts fail closed. This does not alter daemon restart behavior.
It keeps the same workspace volume and writes the ready marker only after a
successful checkout. Authentication, missing revision, local storage, and
unclassified failures stop promptly. The controller accepts only fixed
termination reason codes such as `CheckoutDnsUnavailable` and publishes a
credential-safe status message; unknown or malformed container text remains
`ContainerFailed`. These codes identify the observed fetch failure, not the
underlying DNS service cause. A persistent DNS outage still prevents checkout.

After repairing the cause, explicitly suspend the failed workspace, wait for its
Pod to disappear, then resume it. The replacement Pod gets a fresh retry budget;
the same PVC and any interrupted checkout remain. Do not delete the PVC or its
checkout-ready marker. A successfully initialized PVC bypasses Git entirely on
container or Pod restart, preserving dirty files and never replaying an agent.
The budget applies to one Pod, not indefinitely across operator-created or
controller-created replacement Pods. The initializer is the receipt's sole writer.
This relies on Kubernetes' documented [init container restart behavior](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/#understanding-init-containers)
and [`emptyDir` lifetime](https://kubernetes.io/docs/concepts/storage/volumes/#emptydir):
data survives a container crash and is deleted when its Pod is removed.

One pod and a ReadWriteOnce PVC are sufficient for the local single-node POC,
but are not fencing under node partitions. Never force-delete a pod on an
unreachable node while its volume may still have a writer. Fence the node or
verify the writer is stopped before replacement. EKS storage placement, CSI
ReadWriteOncePod support, availability-zone restrictions, and recovery policies
must be validated before claiming EKS support. No AWS behavior is embedded in
the controller.

Image updates do not forcibly restart workspaces. Suspend/resume idle workspaces
to adopt the configured image. Changes to the checkout revision, branch,
credential-profile reference and project reference require a new workspace;
the CRD enforces that immutability.
The checkout-budget path change must be deployed with both the controller and
workspace image. An old image ignores the new init-only mount; a new image in an
old Pod spec cannot write its required receipt for a fresh or incomplete checkout
and fails closed; an existing checkout-ready marker bypasses the budget. Existing Pods
are not patched or restarted by this controller change, so a controlled
suspend/resume is needed to adopt the paired candidate. Roll back both images
together; do not fall back to the daemon-shared `/tmp` receipt path.

## Claude subscription credentials

Use [Claude's documented setup-token flow](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)
and the `CLAUDE_CODE_OAUTH_TOKEN` environment interface. Each pod keeps its own
provider caches and sessions. A Secret distributes the subscription token;
there is no shared writable login database and no competing refresh-token owners.

Token replacement is operator-managed. Generate a replacement with
`claude setup-token`, then run `npm run credentials -- /path/to/new-token`.
Existing processes retain their original environment. Once a workspace is idle,
suspend it, wait for its Pod to disappear, then resume it. Verify a real prompt
using the replacement token in each workspace. No background job refreshes
subscription credentials, and no active turn is restarted to rotate a token.
The live rotation/expiry scenario must pass before credential renewal is claimed
as accepted. Store the source token file outside Git with restricted permissions;
remove it yourself when no longer needed.

## Docker Desktop disk capacity

`npm run dev:doctor` requires at least 15 GiB free on each Docker Desktop node.
The Mac's free disk space does not determine free space inside Docker's VM.
If pods fail with `ENOSPC`, increase the [Docker Desktop disk usage limit](https://docs.docker.com/desktop/settings-and-maintenance/settings/#advanced),
then rerun the preflight. Do not indiscriminately prune volumes: they may contain
workspace history or data from unrelated projects. The scripts never prune them.

The workspace image disables upstream dictation and voice mode, including their
background local-model downloads. Its startup wrapper clears only the previous
container’s `paseo.pid` runtime lock before executing the upstream entrypoint.
This recovers stale or truncated locks after an interrupted write; files and
history remain on the PVC. It relies on the single-writer and node-fencing
constraints above. Local builds use a unique image tag each time
to avoid stale images cached in kind. Existing workspace pods still adopt a new
image only after an explicit idle suspend/resume.

## Gateway memory budget

The local chart requests 512 MiB and limits the gateway to 1 GiB, with
`gateway.nodeOptions: --max-old-space-size=256`. A long Claude response during
recovery exceeded the original 512 MiB container limit even though JavaScript
heap use stayed below 150 MiB. An instrumented run peaked near 722 MiB RSS and
then fell to about 565 MiB. These are workload observations, not a capacity
or leak-free endurance guarantee.

The [Node heap limit](https://nodejs.org/docs/latest-v24.x/api/cli.html#--max-old-space-sizesize-in-mib)
does not cap total resident memory; leave room for native/runtime allocations.
Measure memory and restarts under representative workloads before changing
`resources` or `gateway.nodeOptions`. Temporary memory instrumentation is not
part of the deployed chart.

## Diagnostics

```sh
kubectl --context docker-desktop -n paseo-system get paseoworkspaces.paseo-gateway.manziman.github.io,pods,pvc
kubectl --context docker-desktop -n paseo-system describe paseoworkspaces.paseo-gateway.manziman.github.io WORKSPACE
kubectl --context docker-desktop -n paseo-system logs deploy/paseo-gateway
```

The gateway logs event categories without raw request bodies, errors or Secret
values. For startup failure, check environment variables, mounted Secret keys
and RBAC. Inspect upstream daemon logs locally when debugging provider failures;
redact private content before sharing. `/healthz` tests process liveness and
`/readyz` checks Kubernetes API access. Kubernetes API outages must not trigger
liveness restarts.

Back up custom resources, identity/profile Secrets and workspace data together.
Treat those backups as sensitive. Restoring only volumes does not restore the
cluster host identity or project/workspace catalog.

### Interrupted teardown recovery

Archive is terminal. The workspace teardown helper persists
`$HOME/.paseo/gateway-teardown-started` with an exclusive create and flushes it
before executing repository hooks. It persists `gateway-teardown-complete` after
successful hooks. Concurrent callers and subsequent reconciliations cannot replay
an unfinished intent, including after a nonzero hook exit: earlier commands may
already have taken effect. Hook output is suppressed and is never copied into
workspace status or gateway logs.

If teardown reports failure/unknown outcome, retain compute and storage and
inspect the hook's external side effects first. Stop concurrent archive attempts
while recovering. An operator who has established that retrying is safe may remove
only `gateway-teardown-started` and any incomplete
`gateway-teardown-complete.tmp` from the workspace's persisted `.paseo` directory,
then explicitly retry archive. Do not remove an existing completion marker or
manually mark completion without verifying all cleanup obligations. The gateway
does not perform this acknowledgment automatically. Do not restore an Archived
workspace; create another workspace with its own lifecycle instead.

### Terminal workspace resource cleanup

Once an Archived workspace's pod is actually absent, the controller removes its
owned Service and scoped access Secret, even if the retained PVC has no expiration.
It verifies workspace ownership labels and uses the observed resource UID as a
Kubernetes deletion precondition. Shared backend/provider Secrets are never part
of this cleanup. Suspended workspaces keep their runtime resources for resume.

PVC retention starts after compute has stopped. A deletion request is not evidence
that a PVC is gone: while finalizers keep it present, the controller retains agent
inventory and creation receipts and reports that deletion is pending. Only observed
absence permits metadata purge and `storageDeletedAt`. Foreign ownership or a UID
conflict refuses cleanup. Workspace CRs remain as lifecycle records after storage
expiration; their count is not bounded by schedule run-history retention. Operators
may remove terminal CRs according to their own metadata retention policy after
verifying cleanup; automatic CR garbage collection is a separate capability.
