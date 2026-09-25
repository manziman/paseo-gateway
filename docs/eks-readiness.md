# EKS readiness before validation

EKS qualification is still pending. Use the detailed
[EKS qualification runbook](eks-qualification.md) for the eventual isolated
installation and acceptance sequence. Passing Docker Desktop tests or a
read-only preflight does not establish EKS storage fencing, network enforcement,
or encrypted transport.

Before scheduling that validation, the operator needs an owned namespace and
release prefix, exact published gateway/workspace image digests and chart/CRD
versions, a compatible encrypted EBS CSI StorageClass, available capacity, and
an explicit credential and source migration plan. Provision distinct retained
gateway and workspace TLS Secrets with verified DNS identities, protected
client ingress, separate gateway identity/signing/backend Secrets, and narrowly
approved Git/provider/private-destination egress. Check the selected EKS
networking mode and startup policy without changing shared add-ons or nodes.
Keep names, endpoints, account identifiers, raw events, and credential material
in an operator-local worksheet.

Run `scripts/eks-preflight.mjs` with an explicit context, namespace, inspected
StorageClass, networking mode (`standard` or `auto`), and local values file.
It checks an Active namespace UID, a
matching chart StorageClass, EBS CSI presence and explicit encryption request,
established served CRDs, operator fixture verbs, scoped egress settings, pinned
digests, separate TLS Secret names, and an external gateway host allowlist.
Review the chart schema with `helm lint` and render manifests before
installation. The preflight cannot prove image pull, actual volume encryption,
certificate trust, live NetworkPolicy behavior, installed gateway RBAC, or
single-writer safety; those remain blocked until observed in the fixture.

The live gate requires an isolated install with exact image/Pod/PVC receipts,
actual encrypted PVC and `ReadWriteOncePod` observations, verified
gateway/backend TLS, approved and denied network probes including startup,
private orchestrator/worker and provider workflows, replacement and
upgrade/rollback/reinstall recovery, capacity/API/OOM/eviction failures,
failed-teardown retention, and UID-checked cleanup. Old-writer fencing needs
a separately approved disposable failure fixture: neither RWO/RWOP nor a
single gateway replica proves it. Grade only actual live evidence with
`scripts/eks-acceptance.mjs`; every unexecuted check remains BLOCKED.
