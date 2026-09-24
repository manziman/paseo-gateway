# HA decision record: retain single-replica MVP, separate controller leadership

Status: evaluated for issue #12; multi-replica operation is not implemented or
claimed safe by this MVP. The deployable default must keep one gateway/controller
replica and use a replacement strategy that does not overlap controllers. Redis
is not required for workspace recovery and is not added as a speculative dependency.

## What survives a gateway restart

| State | Authority / lifetime | HA treatment |
| --- | --- | --- |
| Project/workspace definitions and desired residency | Kubernetes CRs | Shared authority; use resourceVersion/UID preconditions for changes |
| Credential profiles, owner password, scoped signing key, server ID | Kubernetes Secrets | Retain across replacement; isolate role projections; share only among trusted gateway replicas |
| Checkout, upstream database, agent history | Per-workspace PVC | Preserve attachment and backend ownership; never clone live writers |
| Backend pod readiness and CR status | Kubernetes plus observed upstream state | Reconcile after leadership acquisition; stale observations cannot authorize deletion |
| WebSocket, pending request IDs, subscription bindings, binary transfer routes, terminal slots | Per-client gateway session | Discard on disconnect; reconstruct after a fresh hello and subscriptions |
| Directory generation and sequence | Current gateway process | New generation after replacement; require client full snapshot |
| In-flight mutation outcome | Upstream backend or Kubernetes write | May be ambiguous; inspect authority, never automatically replay |
| Optional future catalog cache | Derived from Kubernetes and backend snapshots | Disposable, bounded staleness; never source of authorization |

The existing `DirectoryGeneration` is process-local. A load balancer may route a
new connection to a different process, so the new process must issue a new sync
generation and require a full snapshot. Sharing a sequence counter alone would
not establish a common snapshot or event ordering across backend sessions.

## Next implementable HA increment

Separate the HTTP/WebSocket frontend from a single elected reconciliation leader.
Frontend replicas keep their own client/backend connections. A namespaced
`coordination.k8s.io/v1` Lease selects the controller and scheduler leader. Grant
only Lease get/create/update permissions for this component. Kubernetes documents
Lease-based [leader election](https://kubernetes.io/docs/concepts/architecture/leases/).

Use resourceVersion compare-and-swap to acquire/renew ownership. Configure renewal
deadline below lease duration and instrument renewal latency/loss. A process that
cannot renew within its deadline must immediately stop new reconciliation and
schedule dispatch, cancel work that has not been submitted, and fail readiness for
leadership-required operations. Keep liveness separate to avoid restart storms.
On acquisition, relist state and reconcile before advertising leadership readiness.
The old leader must not keep issuing writes while a new leader takes over.

A Lease is not sufficient storage fencing. A paused or partitioned leader can
resume after losing ownership. Reconciliation writes need object UID and
resourceVersion preconditions; pod creation must use stable names and owner UIDs;
deletion must check the exact pod UID. Long-running operations must recheck current
leadership before committing a write. Any future external system that accepts
mutations must also enforce an epoch/fencing token, or that operation cannot be
made safe merely by extending the Lease duration. This is a design requirement,
not a guarantee supplied by the current controller.

Keep one upstream daemon writer per workspace PVC. `ReadWriteOnce` permits several
pods on the same node, so it does not enforce single-pod ownership. Prefer
`ReadWriteOncePod` with a compatible CSI driver for stronger pod-level attachment
constraints; validate that the actual StorageClass supports it. Kubernetes'
[access-mode documentation](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes)
describes this distinction. Never force-delete a partitioned writer and launch a
replacement until storage fencing proves the previous node cannot still write.
RWX storage is not a substitute for daemon/database concurrency guarantees.

## Redis alternatives and outage behavior

1. Kubernetes authority plus disposable per-process caches is the recommended next
   increment. It minimizes new failure modes and preserves current recovery.
2. Redis can later hold bounded derived catalog caches or fan-out notifications if
   measured read load warrants it. On outage, bypass the cache and read Kubernetes
   with backpressure; if authority is unavailable, report unavailable, never an
   authoritative empty inventory. On recovery, rebuild under a new cache epoch.
3. Redis as distributed lock, session authority, or mutation replay queue is rejected
   for this increment. It would add durability, ordering, security and failover
   requirements without solving backend single-writer ownership or exactly-once
   agent mutations.

Redis replication is asynchronous. `WAIT` can improve acknowledgment durability,
but does not make Redis strongly consistent or eliminate failover write loss.
Therefore a Redis lock or cached authorization entry cannot independently prove
exclusive workspace ownership. See the official [replication
documentation](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
and [`WAIT` guarantees](https://redis.io/docs/latest/commands/wait/).

If Redis later becomes mandatory for shared revocation or coordination, outage must
fail closed for those dependent operations, with existing streams explicitly
closed when authorization can no longer be established. Do not silently fall back
from mandatory shared security state to independent per-process state. That choice
needs an additional design review; the current implementation has no Redis mode.

## Failover contract and required acceptance

Frontend death closes sockets; clients reconnect, reload a full directory snapshot,
rebind subscriptions and terminal slots, and resume observation of existing backend
work. Pending RPCs fail with an ambiguous outcome. Automatic reconnect must never
reissue prompts, creates, archive requests, terminal input, or file chunks. Request
IDs are session correlation, not durable idempotency keys. Exactly-once execution
would require a backend-persisted deduplication contract before adding replay.

Before enabling more than one replica, automate these checks:

- Competing Lease contenders, conflict retries, process pause beyond lease expiry,
  partitioned API access, and old-leader resumption: exactly one permitted writer.
- Leader death during pod creation/deletion and status patch: no duplicate daemon,
  no deletion of a replacement UID, retained PVC and credential projection.
- Gateway death after backend mutation dispatch but before response: one upstream
  action, reported ambiguity, and observation after reconnect without replay.
- Two frontend replicas: scoped inventory isolation, unique sync generations,
  subscription restoration, binary route reconstruction, bounded buffering.
- Node/storage partition: old writer fenced before replacement; verify on the
  production CSI driver, not only Docker Desktop's local-path storage.
- Shared signing key rotation, origin archival/recreation, token expiry and API
  outage: all replicas reject stale authorization consistently.
- If Redis is introduced: timeout, full outage, replica promotion with lost writes,
  restored stale cache, and bounded fallback load; no stale authority promotion.

Measure reconnect recovery time, controller failover time, inventory convergence,
and backend work survival separately. A process replica count alone is not evidence
of HA, and this evaluation does not close the future implementation/test gates.
