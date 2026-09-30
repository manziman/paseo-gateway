# Optional Git reference caches

A project may reference an administrator-maintained Git mirror on an existing PVC:

```yaml
spec:
  cache:
    claimName: repository-mirrors
    subPath: organization/repository.git
```

The PVC must be in the workspace namespace and support the cluster's scheduling
and access-mode requirements. Use a bare mirror or full Git checkout, not a shallow
repository. The optional subpath must be a safe relative path. The controller
checks whether the claim exists; an absent claim becomes a cold checkout. A bound
claim with an unmountable or nonexistent subpath can prevent Pod startup; omit
subPath or provision its directory before configuring it. The existence check
does not establish that the PVC is bound, healthy, or attachable on the chosen node.

Only the checkout container mounts `/reference/git`, and both the PVC volume and
mount are read-only. The daemon cannot access it. Missing, malformed, or shallow
Git repositories fall back to a normal fetch. Checkout may borrow objects through
a temporary Git alternate, then runs a full repack and removes the alternate
before writing the ready marker. Deleting or garbage-collecting the reference
cache afterward cannot remove the workspace's objects. A fetch failure identified
as missing or corrupt alternate data removes the alternate and attempts a cold
fetch within the same three-attempt, 150-second fetch budget. Authentication,
revision, and unclassified errors do not trigger this cache fallback. The initializer does not
write to the cache or copy its working-tree contents, hooks, or credential
configuration into the workspace. A successful checkout test deletes the reference and runs `git fsck
--full` to verify independence.

Maintain mirrors outside workspace Pods with a separate operator-controlled job.
Keep credentials out of mirror URLs/configuration and avoid mutating a cache while
a checkout reads it; publish a new mirror directory or snapshot atomically. The
cache is an optimization, not the source of workspace persistence. It does not
share writable `node_modules`, provider homes, build outputs, or package-manager
state between workspaces. Read-only dependency caches can be supplied by a custom
image; shared writable dependency directories are intentionally not implemented.

## Reproducible fixture benchmark

Run `node scripts/cache-benchmark.mjs`. It creates a temporary six-commit repository
containing 24 MiB of incompressible files, performs three cold and three reference
checkouts over local file transport with full history, checks repository integrity,
and removes all fixture data. It does not inspect user repositories or credentials.

One local macOS run on 2026-09-24 measured:

| Run | Cold checkout | Reference + dissociation |
| --- | ---: | ---: |
| 1 | 1694 ms | 1151 ms |
| 2 | 1699 ms | 1236 ms |
| 3 | 1720 ms | 1154 ms |

These are synthetic local measurements, not cluster or private-repository results.
Network latency, PVC throughput, repository history, compression, fetch depth, and
concurrent workload change the result. Dissociation still copies the needed Git
objects into each workspace, so it does not eliminate workspace storage costs.
