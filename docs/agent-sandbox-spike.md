# Agent Sandbox adoption spike

**Decision: do not adopt v1.0.3 yet.** The release is not a drop-in replacement,
and the prototype does not meet the project's no-regressions adoption requirement.
The upstream controller can run our workspace PodSpec, but preserving current
behavior requires retaining more of our controller than the initial assessment
suggested. In particular, UID-fenced deletion remains an unresolved safety gap.

This is a throwaway experiment on `spike/agent-sandbox-v1.0.3`, not a production
backend. No production source path imports `sandbox-prototype.ts`. Main and the
existing Docker Desktop Paseo deployment are unchanged by this spike.

## Question and scope

Can Agent Sandbox replace our Kubernetes resource lifecycle without regressing
existing Paseo workspace functionality or deletion guarantees?

Baseline: gateway commit `62a7c6b`, upstream Paseo 0.9.1, Docker Desktop Kubernetes.
Candidate: Agent Sandbox **v1.0.3**, source commit
`527d9346fe1d237dea5c003f3c720531c7bab1df`, controller image
`registry.k8s.io/agent-sandbox/agent-sandbox-controller@sha256:8c8f5814c16bd68631af0496a5fa4eb9bedce4d032de88b956130a041d9f438e`.
Only the core controller is installed for the experiment. Templates, claims, warm
pools, sandbox-router, and alternate container runtimes are not installed.

The prototype reuses the real `WorkspaceController`, `desiredResources`,
`KubernetesStore`, credential projection and durable teardown implementation.
`SandboxPrototypeStore` delegates Pod creation to a core Sandbox of the same
UID-derived name, preserving the full PodSpec and workspace labels. It keeps
PVCs and ClusterIP Services under existing management, sets `service: false`,
omits `volumeClaimTemplates`, and normally leaves native expiration unset.
Stop requests set `operatingMode: Suspended` before cleanup to prevent automatic
Pod recreation. This wrapper deliberately exposes unresolved design problems;
it is not migration-ready.

## Findings and adoption blockers

| Existing contract | Native v1.0.3 behavior | Required treatment |
| --- | --- | --- |
| Retain disks when the workspace record is deleted | Template PVCs are controlled by the Sandbox and can be garbage-collected with it | Keep existing unowned PVCs; never translate Retain storage directly into `volumeClaimTemplates` |
| Refuse archive when teardown fails or its outcome is unknown | Native deadlines delete compute without asking Paseo to run or approve teardown | Keep our archive state machine; do not use `shutdownTime` as archive/TTL policy |
| Wait for actual Pod/PVC deletion before archive/retention completion | `SandboxExpired` can be reported after issuing deletion while finalizers still hold children | Continue observing child-resource absence; preserve archive timestamps and inventory purge ordering |
| Delete only the exact observed resource UID | Core ownership checks are followed by name-based deletes without UID preconditions | **Unresolved blocker:** require an upstream fix or another verified mechanism before delegating stop operations |
| Reject ephemeral suspension; preserve terminal ephemeral evidence | Core supports suspension regardless of storage type | Retain our ephemeral guards; do not expose raw Sandbox suspension to consumers |
| Recover terminal retained-storage Pods | Core leaves an existing Failed/Succeeded Pod and reports Finished | Keep terminal-Pod recovery and persisted diagnostics in the adapter |
| Enforce physical capacity during direct-CR reconciliation | Core has no project/namespace capacity admission; Pod creation becomes asynchronous | Reserve pending Sandbox slots as well as Pods, including resume/recovery; the prototype does not implement this |
| Use stable existing Service/pod naming and exec paths | Native Service is headless and core refuses objects controlled by another controller | Keep current Service with `service: false`; migration must deliberately transfer/recreate Pod ownership |
| Preserve credential projection, identity, init, image and resources | Core accepts a complete PodSpec | Pass through the generated PodSpec and labels; retain our credential broker and access authority |
| Apply current project/profile configuration on resume | The minimal adapter reuses its original Sandbox PodTemplate | Refresh and validate the template before enabling compute; in-place Secret contents still rotate normally |
| Preserve current network isolation and private-network access | Template-managed NetworkPolicy introduces different ingress/egress allowances | Use core alone or unmanaged template networking until equivalent enforced policies are tested |

Sources: [pinned core API](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/api/v1beta1/sandbox_types.go),
[PVC ownership](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/controllers/sandbox_controller.go#L1632-L1708),
[expiry](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/controllers/sandbox_controller.go#L1712-L1788),
[suspend deletion](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/controllers/sandbox_controller.go#L1256-L1269),
[controller-runtime Delete](https://github.com/kubernetes-sigs/controller-runtime/blob/v0.25.0/pkg/client/typed_client.go#L80-L98),
[existing Pod handling](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/controllers/sandbox_controller.go#L1290-L1388),
[Service reconciliation](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/controllers/sandbox_controller.go#L994-L1109).
Baseline contracts are implemented in `src/controller/controller.ts`,
`src/controller/resources.ts`, `src/kubernetes/client.ts`, and `docker/teardown.mjs`.

The UID issue is source-confirmed, not a reproduced live race. Checking an owner
UID before deletion is insufficient if a same-name replacement appears between
the read and delete. Our current Kubernetes client explicitly sends UID
preconditions; the candidate's deletion calls do not. A normal successful suspend
test cannot establish equivalence for this failure case.

### Additional defects reproduced in the minimal adapter

These are problems with the proposed integration, not claims that upstream
promises Paseo-specific policy:

- Pausing the temporary upstream controller, then reconciling two direct Workspace
  CRs under `namespaceLimit=1`, queues two Running Sandboxes. When core resumes,
  both Pods appear. The existing gateway API admission still works; the regression
  is in physical-Pod capacity enforcement for direct CRs/resume/recovery.
- Suspending one of those Workspaces before its Pod exists reports `Suspended`,
  but never changes the queued Sandbox out of Running. Its Pod subsequently starts.
  The current direct-Pod controller has no independent queued creator to fence.
- A same-name Sandbox carrying a different workspace UID is resumed by the
  prototype. Existing-Sandbox mutation needs ownership validation in addition to
  deletion preconditions. All collision resources in the probe are disposable
  test fixtures, not resources belonging to another user.
- On resume, changing a project's memory request is ignored because the prototype
  updates only Sandbox operating mode. Baseline reconstruction uses the current
  project/profile settings. Native automatic replacement likewise needs analysis
  of current credential/project preflight before restart.

The fix requires explicit desired-compute state and pending capacity reservations;
overriding Store create/delete methods is insufficient. Archived-state fencing
also needs to account for the new Sandbox mutation surface. This is not an
unauthenticated gateway vulnerability: patching Sandboxes requires Kubernetes
permissions, and privileged Pod creation already bypasses gateway policy.

## Optional extensions

Generic warm pools are not a compatible shortcut for our current workspace model.
Checkout inputs, repository credentials, scoped access Secret references, cwd,
image and resources are fixed before Pod startup. Claim env accepts literal values,
not Secret `valueFrom`, and specifying env or PVC templates forces a cold start.
Prewarming a credential-bearing template also checks out its repository before a
consumer is assigned. This needs a separate design and security evaluation.

Template-managed networking can deny in-cluster DNS/gateway access under defaults,
or broaden existing restrictive egress through additive NetworkPolicy allowances.
Preserving labels is necessary but does not prove network enforcement on the
chosen CNI. Core Sandbox itself does not impose this template policy.

Sources: [claim API](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/extensions/api/v1beta1/sandboxclaim_types.go),
[claim controller](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/extensions/controllers/sandboxclaim_controller.go),
[template networking](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/extensions/controllers/sandboxtemplate_controller.go).

## Reproduce

Use a disposable Docker Desktop installation or explicitly approve the temporary
cluster-scoped controller/RBAC installation. The harness only writes
`paseo-sandbox-spike` and fails if that namespace already exists. It reads a
previously authorized test project/profile from `paseo-mvp` (override with
`PASEO_SOURCE_NAMESPACE` and `PASEO_TEST_PROJECT`), copies their referenced
Secrets/ConfigMaps in memory, and uses an already-loaded workspace image. It does
not print credential values, push branches, create PRs, or invoke model inference.

```sh
kubectl --context docker-desktop apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.3/sandbox.yaml
npm run prototype:sandbox
npm run prototype:sandbox:races
```

The harness uses actual Kubernetes resources and the upstream controller; it is
not a mock of their lifecycle. Its SDK connection is port-forwarded through the
preserved Service directly to the workspace daemon. It therefore verifies that
transport, but does **not** establish full gateway CLI/SDK parity or in-cluster
DNS/NetworkPolicy behavior. The synthetic projected-token update tests file
rotation, not authentication of that synthetic value. No credential values belong
in result files or issue bodies.

After inspecting results, delete only the spike namespace and the installation
created for this experiment. Before deleting the CRD/controller, confirm there
are no other Sandbox users; deleting the CRD would delete their records too.
Remove any test hold finalizer before namespace cleanup if a run was interrupted.

The second command deliberately pauses only the temporary Agent Sandbox
controller, queues isolated fixture workspaces, and restores it to expose timing
races. Run it after the first command completes and before cleanup.

## Results

Docker Desktop live run on 2026-09-24:

| Probe | Result |
| --- | --- |
| Existing private SSH checkout, environment, image and pod security | PASS |
| Authenticated Paseo 0.9.1 SDK provider catalog and terminal creation | PASS through retained Service port-forward |
| Whole-volume access Secret update without Pod restart | PASS |
| Suspend stops compute; retained PVC UID unchanged | PASS on ordinary ready-Pod path |
| Resume retains home file, Service IP and SDK connectivity | PASS |
| Deleted retained Pod is recreated with disk contents intact | PASS |
| Nonzero teardown keeps compute, Sandbox and disk | PASS with adapter; native deadline bypass reproduced separately |
| Successful archive tears down compute/Sandbox, retains external PVC | PASS |
| Workspace record deletion retains external PVC | PASS |
| Ephemeral suspend refusal and successful archive | PASS with adapter |
| Archive TTL waits behind PVC finalizer for actual deletion | PASS with adapter |
| Native `SandboxExpired` while Pod still held by finalizer | REGRESSION REPRODUCED |
| Native template PVC garbage-collected with Sandbox | REGRESSION REPRODUCED |
| Native deadline removes compute despite failed Paseo teardown | REGRESSION REPRODUCED |
| Queued creation starts a Pod after Workspace reports Suspended | REGRESSION REPRODUCED |
| Two Pods appear under physical namespace cap of one | REGRESSION REPRODUCED |
| Adapter resumes foreign-UID same-name Sandbox fixture | REGRESSION REPRODUCED |
| Resume ignores a changed project memory request | REGRESSION REPRODUCED |

Both probes use the real upstream controller. Standard repository checks pass:
TypeScript, Biome, build, and 153 tests (two executable CLI cases remain skipped
by the ordinary unit command). Full official CLI acceptance was not rerun against
this incomplete backend. Passing adapter probes do not override blockers.

Not claimed by this spike: full gateway parity, real agent inference, private Git
push/PR creation, schedule-to-worker spawning, enforced networking, gVisor/Kata,
in-place migration of existing workloads, active-turn Pod-loss behavior, or a live
reproduction of the UID deletion race. These remain explicit adoption gates;
finding concrete blockers is sufficient to reject immediate adoption.

## Required gates before reconsidering adoption

- Fix UID-fenced deletion and deterministically test stale-read/replacement races.
- Make pending Sandbox reservations part of capacity and residency reconciliation;
  test suspend/archive before a Pod appears and concurrent recovery/resume.
- Prove terminal Pod recovery, ephemeral refusal, teardown failure/timeout/unknown
  outcome, Pod/PVC finalizers, inventory retention and credential revocation.
- Define and test migration of existing owned Pods without losing disks or replaying
  active agent mutations. Do not silently adopt or strip existing ownership.
- Run the existing full gateway acceptance suite against the proposed backend:
  schedules, orchestrator/worker spawning, scoped auth, private clone/push/PR,
  CLI fixtures, file/binary/terminal traffic, gateway and workspace recovery.
- Verify equivalent network policy enforcement and private egress on a supporting
  CNI; test any target gVisor/Kata RuntimeClass independently.
- Keep existing GitHub App and shared Codex renewal limitations explicit; Agent
  Sandbox does not resolve either credential authority problem.

The useful adoption boundary is narrower than “replace our controller”: delegate
Pod provisioning while keeping Paseo lifecycle and policy authoritative. Whether
that maintenance saving justifies another controller remains an architectural
decision after the regression blockers are resolved.
