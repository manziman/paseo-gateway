# Paseo Kubernetes gateway chart

An independent community gateway for Paseo on Kubernetes. It is not affiliated
with or endorsed by Paseo. This chart installs a single gateway controller in a
namespace. Use **one release per namespace** because Service, RBAC, and workspace
resource names are fixed.

## Requirements

- Kubernetes 1.32–1.35; Helm 3.17–3.20, selecting a Helm minor compatible with
  the cluster under [Helm's version skew policy](https://helm.sh/docs/v3/topics/version_skew/).
  CI exercises Kubernetes 1.32 and 1.35 endpoints. Intermediate minors are in
  the declared range but are not individually exercised.
- A default `ReadWriteOnce` StorageClass or an explicit `workspace.storageClass`.
  Each retained workspace asks for `workspace.storageSize` (default 5Gi). The
  gateway requests 100m CPU/512Mi RAM and is limited to 1 CPU/1Gi RAM. A running
  workspace additionally requests at least 350m CPU/640Mi RAM and limits its
  init/daemon containers to 1 CPU/512Mi and 2 CPU/2Gi respectively. Allow room
  for the control plane and image pulls.
- Permissions to create namespaced Secrets, apply the three cluster-scoped CRDs,
  and install namespaced Deployments, RBAC, NetworkPolicies, and Services. The
  runtime ServiceAccount needs namespaced CRUD for its owned resources; the chart
  does not grant cluster-wide runtime permissions.
- `kubectl`, `openssl`, and `uuidgen` for the packaged Secret bootstrap helper.
  Images and chart must be pullable from the selected registry. Public GHCR
  visibility is verified separately from chart packaging.

The gateway and workspace images default to the matching published GHCR
repositories and `Chart.appVersion`. A packaged release may pin their digests.
Use `image.digest` and `workspace.digest` for immutable overrides; these take
precedence over their tags. `workspace.image` is a complete-reference override
for local development. No source checkout, npm, or image build is needed to
install a published chart.

## Install from a chart package

Set `CONTEXT`, `NAMESPACE`, `VERSION`, and a temporary `CHART_DIR` in your shell.
Always name the target context in both `kubectl` and Helm commands. The commands
below show the published OCI address; verify the desired version and registry
visibility before using it.

```sh
export CONTEXT=your-cluster-context NAMESPACE=paseo-system VERSION=1.0.0-alpha.1
export CHART_DIR="$(mktemp -d)"
helm pull oci://ghcr.io/manziman/charts/paseo-kubernetes \
  --version "$VERSION" --untar --untardir "$CHART_DIR"
kubectl --context "$CONTEXT" create namespace "$NAMESPACE"
kubectl --context "$CONTEXT" apply --server-side -f "$CHART_DIR/paseo-kubernetes/crds/"
kubectl --context "$CONTEXT" wait --for=condition=Established --timeout=90s \
  crd/paseoprojects.paseo-gateway.manziman.github.io \
  crd/paseoworkspaces.paseo-gateway.manziman.github.io \
  crd/paseocredentialprofiles.paseo-gateway.manziman.github.io
bash "$CHART_DIR/paseo-kubernetes/files/bootstrap-secrets.sh" \
  --context "$CONTEXT" --namespace "$NAMESPACE"
helm upgrade --install paseo "$CHART_DIR/paseo-kubernetes" \
  --kube-context "$CONTEXT" --namespace "$NAMESPACE" --wait --timeout 5m
```

The bootstrap helper creates only missing Secrets and marks new ones immutable.
It preserves existing values on every run and prints only Secret names and
status. `paseo-identity` contains `password` (at least 32 bytes) and `serverId`;
`paseo-backend` and `paseo-signing` each contain `password` (at least 32 bytes).
Back up all three with the custom resources and workspace PVCs. For externally
managed Secrets, create these keys yourself and set `gateway.identitySecret`,
`gateway.backendSecret`, and `gateway.signingSecret` to their names. Existing
Secrets are never managed or rotated by Helm. Keep all names distinct. Treat
backup material as sensitive.

The gateway authenticates clients with the retained identity password. Provider
credentials are separate namespaced Secrets referenced by
`PaseoCredentialProfile` records. The chart does not create credentials or make
model calls. You may connect locally with an explicit context:

```sh
kubectl --context "$CONTEXT" --namespace "$NAMESPACE" port-forward \
  service/paseo-gateway 6768:8080
```

Read the identity password into your own client without printing it in shared
logs. Set credential profiles before starting workspaces. The default ingress
NetworkPolicy admits gateway-to-workspace traffic. Optional egress policies are
additive and must include DNS, gateway, Git, and provider destinations that the
workspace needs. Pod security uses non-root UID 1000, a read-only root filesystem
for the gateway, dropped capabilities, and RuntimeDefault seccomp. The gateway
Service is ClusterIP, not public ingress.

## Values

| Value | Default | Meaning |
| --- | --- | --- |
| `image.repository`, `workspace.repository` | GHCR repositories | Published image names. |
| `image.tag`, `workspace.tag` | empty | Empty uses packaged `appVersion`. |
| `image.digest`, `workspace.digest` | empty | `sha256:` digest overrides tag. |
| `workspace.image` | empty | Complete image reference override; takes precedence over workspace repository/digest/tag. |
| `image.pullPolicy`, `workspace.pullPolicy` | `IfNotPresent` | Kubernetes image pull policy. |
| `gateway.identitySecret`, `backendSecret`, `signingSecret` | retained Secret names | Existing Secret references; chart does not create them. |
| `workspace.storageClass`, `storageSize` | default class, `5Gi` | RWO workspace PVC configuration. |
| `resources` | gateway requests/limits above | Gateway Pod resources. |
| `networkPolicy.enabled`, `egress.enabled` | `true`, `false` | Workspace ingress isolation and optional egress restrictions. |

`values.schema.json` rejects unknown and malformed chart settings, including
invalid Secret names, quantities, image digests, and pull policies. Test custom
values with `helm lint CHART -f values.yaml` and
`helm template paseo CHART --namespace "$NAMESPACE" -f values.yaml`.

## Upgrade, restart, and removal

Back up Secrets, all `PaseoProject`/`PaseoWorkspace`/`PaseoCredentialProfile`
objects, and retained PVC data before upgrade. Pull and inspect the candidate
chart. Apply candidate `crds/` explicitly, wait for Established, then run
`helm upgrade` with the existing release name, namespace, context, and values.
Helm installs CRDs from `crds/` on initial installation but **does not upgrade or
delete them**. Applying the CRDs is a separate cluster-scoped operation; inspect
schema compatibility with existing records first. A rollback of a Helm release
does not roll back CRDs. Reverting a CRD may be unsafe if newer objects already
use fields or versions unavailable to the old schema. Restore only from a
verified backup and a compatible chart/CRD pair.

An ordinary gateway restart or Helm upgrade keeps Secret values, server ID,
workspace records, and PVC UIDs. The single gateway uses a Recreate deployment
strategy. Existing workspace Pods continue through gateway replacement. Updating
the default workspace image does not restart them; suspend and resume an idle
workspace to adopt the new image. Retained workspaces keep their PVC on archive
unless a storage TTL was set; ephemeral workspaces use `emptyDir` and cannot be
suspended. A held PVC finalizer delays storage collection until Kubernetes
actually deletes the volume.

Before `helm uninstall`, suspend workspaces so their compute stops. Uninstall
removes the gateway, Service, RBAC, and NetworkPolicies but retains CRDs, custom
records, manually provisioned Secrets, and workspace PVCs. Removing a namespace
or deleting a retained PVC destroys data. A reinstallation with the same
namespace and retained Secrets resumes the same host identity. Do not regenerate
Secrets for an existing catalog.

The historical pre-release API group used different CRD identities. Applying
the current CRDs cannot migrate those records in place: object UIDs change and
PVC names and ownership depend on them. Keep the old installation and data,
export its records and Secrets, back up PVC contents, then migrate into a fresh
namespace and verify restoration before retirement. There is no automated
cross-group PVC adoption or migration. See the project's
[operations guide](https://github.com/manziman/paseo-gateway/blob/main/docs/operations.md#api-group-transition).

This chart is Apache-2.0 licensed; see `LICENSE`, `NOTICE`, and
`THIRD_PARTY_NOTICES.md` in the package. The full dependency inventory and
image redistribution notes are in the project's
[redistribution guide](https://github.com/manziman/paseo-gateway/blob/main/docs/redistribution.md).
