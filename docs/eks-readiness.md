# EKS readiness before validation

EKS qualification is still pending. Use the detailed
[EKS qualification runbook](eks-qualification.md) for the eventual isolated
installation and acceptance sequence. Passing Docker Desktop tests or a
read-only preflight does not establish EKS storage fencing, network enforcement,
or encrypted transport.

## Candidate gate

Complete these local checks before selecting the EKS candidate:

1. Merge the permission-disconnect and retained-history fixes after their
   regression, native daemon, security and chart checks pass. Replay an actual
   CLI permission denial; a successful command exit alone does not prove the
   waiting agent received the decision.
2. Run the remaining [Desktop checks](manual-desktop-acceptance.md): a fresh
   preference profile with a cold project catalog, nondefault branch selection,
   first-turn activity without refresh, and opening a stopped conversation from
   a newly captured history snapshot. Keep old-image history limitations explicit.
3. Stage and qualify one immutable public alpha artifact set using the
   [release runbook](releasing.md). Record exact image and chart digests for the
   install, recovery, provider and private-worker tests. Development-image
   evidence does not qualify a different published image.

The [local qualification log](local-parity-qualification.md) distinguishes
completed observations from pending checks. EKS validation and actual provider
expiry or independently valid credential rotation remain separate gates; neither
is satisfied by generated-invalid credential tests. Do not mark the parity epic
complete merely because the candidate is ready for cloud validation.

## Operator prerequisites

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
