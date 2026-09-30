# EKS readiness before validation

EKS qualification is still pending. Use the detailed
[EKS qualification runbook](eks-qualification.md) for the eventual isolated
installation and acceptance sequence. Passing Docker Desktop tests or a
read-only preflight does not establish EKS storage fencing, network enforcement,
or encrypted transport.

## Candidate gate

The permission-disconnect and retained-history fixes are merged, with regression,
native daemon, security and chart checks. Real local permission denial and
approval reached the intended workers; CLI exit alone was not used as proof.
The [local qualification log](local-parity-qualification.md) and
[Desktop checklist](manual-desktop-acceptance.md) record the completed fresh
preference/cold catalog, selected nondefault branch, automatic first turn and
stopped-conversation checks. Old images and stopped volumes without a committed
history snapshot still have an explicit migration limit.

The published [alpha.5 release](https://github.com/manziman/paseo-gateway/releases/tag/v1.0.0-alpha.5)
identifies source `4b3a2f4a8cbb565dc2150ef6a43ddd7061f58433` and immutable
gateway, workspace and chart digests. Its downloaded assets passed checksum and
anonymous-consumption verification. Fresh-chart acceptance passed with the exact
artifacts. Authenticated Claude, Codex and OpenCode prompts, Claude/Codex
active-turn recovery, GitHub App renewal, and the private scheduled
orchestrator/worker workflow passed on those image digests. The existing
installation upgrade preserved original workspace/Pod/PVC identities and
credential authorities. The [release qualification record](https://github.com/manziman/paseo-gateway/releases/download/v1.0.0-alpha.5/qualification.md)
separates those exact-artifact results from earlier Desktop observations,
unselected fault tests and the test-only Git harness correction.

Operator-led EKS validation is next and remains a separate gate. Actual
provider-side expiry, independently valid credential replacement, EKS storage
fencing and live network enforcement are not established by the local checks.
Do not mark the full-parity epic complete merely because a public alpha is
available or a candidate is ready for cloud validation.

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
