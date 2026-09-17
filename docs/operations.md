# Operations

## Lifecycle and recovery

Local examples always name the Docker Desktop context and `paseo-system`
namespace. Change an individual workspace's residency to stop or resume compute:

```sh
kubectl --context docker-desktop -n paseo-system patch paseoworkspace WORKSPACE \
  --type merge -p '{"spec":{"residency":"Suspended"}}'
kubectl --context docker-desktop -n paseo-system patch paseoworkspace WORKSPACE \
  --type merge -p '{"spec":{"residency":"Running"}}'
```

Archive through the desktop or set residency to `Archived`. Both stop compute
and retain the record and PVC. Explicitly deleting a workspace record also
retains its PVC; its Pod/Service are garbage-collected. Record the old PVC name
and back up data before deleting records. Automatic adoption/restoration of an
orphan PVC is not implemented. A newly created record gets a new volume.

Deleting a PVC or namespace can destroy retained storage. The controller does
neither. Helm uninstall retains CRDs, custom records, manually provisioned
Secrets and PVCs, but also stops reconciliation; suspend workspaces before
uninstalling to stop their compute. Local development does not include a
destructive `down` command.

Gateway replacement disconnects clients while agents keep running. A request
whose response is lost may have executed. Inspect agent history before retrying;
no mutation is automatically replayed. Reconnect creates a new directory
generation and fetches full snapshots. Workspace pod replacement can interrupt
an active turn even though files and provider history survive.

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

## Diagnostics

```sh
kubectl --context docker-desktop -n paseo-system get paseoworkspaces,pods,pvc
kubectl --context docker-desktop -n paseo-system describe paseoworkspace WORKSPACE
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
