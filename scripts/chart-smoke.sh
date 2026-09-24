#!/usr/bin/env bash
set -euo pipefail

: "${CHART_CONTEXT:?Set the isolated kind context}"
: "${CHART_NAMESPACE:?Set the test-owned namespace}"
: "${CHART_PACKAGE:?Set the candidate chart archive path}"
: "${CHART_DIAGNOSTICS:?Set a diagnostics directory}"
if [[ "$CHART_NAMESPACE" != chart-* ]] ||
  { [[ "$CHART_CONTEXT" != kind-chart-* ]] &&
    { [[ "$CHART_CONTEXT" != docker-desktop || "${CHART_LOCAL_DOCKER_DESKTOP:-0}" != 1 ]]; }; }; then
  echo 'Refusing to run outside a chart-owned kind context or explicitly enabled Docker Desktop test namespace' >&2
  exit 2
fi
kubectl --context "$CHART_CONTEXT" get --raw /version >/dev/null
mkdir -p "$CHART_DIAGNOSTICS"
namespace="$CHART_NAMESPACE"
context="$CHART_CONTEXT"
kc() { kubectl --context "$context" --namespace "$namespace" "$@"; }

diagnostics() {
  local status="$1"
  if ((status != 0)); then
    kc get deployment,pods,services,pvc,paseoworkspaces,paseoprojects,paseocredentialprofiles -o wide > "$CHART_DIAGNOSTICS/resources.txt" 2>&1 || true
    kc get events --sort-by=.lastTimestamp > "$CHART_DIAGNOSTICS/events.txt" 2>&1 || true
    helm status paseo --kube-context "$context" --namespace "$namespace" > "$CHART_DIAGNOSTICS/helm-status.txt" 2>&1 || true
    echo "Chart smoke failed; redacted resource and event diagnostics are in $CHART_DIAGNOSTICS" >&2
  fi
}

on_exit() {
  local status=$?
  if [[ -n "${workdir:-}" ]]; then rm -rf "$workdir"; fi
  diagnostics "$status"
}
trap on_exit EXIT

wait_field() {
  local type="$1" name="$2" path="$3" expected="$4" timeout="${5:-300}" start value
  start=$SECONDS
  while ((SECONDS - start < timeout)); do
    value="$(kc get "$type" "$name" -o "jsonpath={$path}" 2>/dev/null || true)"
    if [[ "$value" == "$expected" ]]; then return 0; fi
    if [[ "$path" == '.status.phase' && "$value" == Failed ]]; then
      echo "$type/$name entered Failed phase" >&2
      return 1
    fi
    sleep 3
  done
  echo "Timed out waiting for $type/$name $path=$expected (last: $value)" >&2
  return 1
}

wait_nonempty() {
  local type="$1" name="$2" path="$3" timeout="${4:-300}" start value
  start=$SECONDS
  while ((SECONDS - start < timeout)); do
    value="$(kc get "$type" "$name" -o "jsonpath={$path}" 2>/dev/null || true)"
    if [[ -n "$value" ]]; then return 0; fi
    sleep 3
  done
  echo "Timed out waiting for $type/$name $path" >&2
  return 1
}

secret_fingerprint() {
  kc get secret "$1" -o json | jq -c '.data' | sha256sum | cut -d ' ' -f 1
}

assert_retained() {
  local name now i
  for i in 0 1 2; do
    name="${secret_names[$i]}"
    now="$(secret_fingerprint "$name")"
    if [[ "$now" != "${secret_hash[$i]}" ]]; then
      echo "$name changed across chart operation" >&2
      exit 1
    fi
    if [[ "$(kc get secret "$name" -o jsonpath='{.metadata.uid}')" != "${secret_uid[$i]}" ]]; then
      echo "$name UID changed across chart operation" >&2
      exit 1
    fi
  done
  if [[ "$(kc get pvc "$retained_pvc" -o jsonpath='{.metadata.uid}')" != "$retained_uid" ]]; then
    echo 'Retained workspace PVC UID changed' >&2
    exit 1
  fi
  if [[ "$(kc exec "pod/$retained_pvc" -c daemon -- cat /home/paseo/chart-smoke.txt)" != chart-smoke-marker ]]; then
    echo 'Retained workspace data changed' >&2
    exit 1
  fi
}

workdir="$(mktemp -d)"
tar -xzf "$CHART_PACKAGE" -C "$workdir"
chart_dir="$workdir/paseo-kubernetes"
[[ -f "$chart_dir/files/bootstrap-secrets.sh" && -f "$chart_dir/README.md" && -f "$chart_dir/LICENSE" ]]
kubectl --context "$context" create namespace "$namespace" --dry-run=client -o yaml |
  kubectl --context "$context" apply -f -
if [[ "${CHART_SKIP_CRD_APPLY:-0}" == 1 ]]; then
  kubectl --context "$context" diff -f "$chart_dir/crds/"
else
  kubectl --context "$context" apply --server-side -f "$chart_dir/crds/"
fi
kubectl --context "$context" wait --for=condition=Established --timeout=90s \
  crd/paseoprojects.paseo-gateway.manziman.github.io \
  crd/paseoworkspaces.paseo-gateway.manziman.github.io \
  crd/paseocredentialprofiles.paseo-gateway.manziman.github.io
bash "$chart_dir/files/bootstrap-secrets.sh" --context "$context" --namespace "$namespace"
secret_names=(paseo-identity paseo-backend paseo-signing)
secret_hash=()
secret_uid=()
for name in "${secret_names[@]}"; do
  secret_hash+=("$(secret_fingerprint "$name")")
  secret_uid+=("$(kc get secret "$name" -o jsonpath='{.metadata.uid}')")
done

install_args=(--kube-context "$context" --namespace "$namespace" --set-string workspace.storageSize=1Gi)
if [[ "${CHART_USE_PACKAGE_DEFAULTS:-0}" == 1 ]]; then
  : "${CHART_EXPECT_GATEWAY_IMAGE:?Set the published gateway repository@digest}"
  : "${CHART_EXPECT_WORKSPACE_IMAGE:?Set the published workspace repository@digest}"
else
  install_args+=(--set-string "image.repository=${CHART_GATEWAY_REPOSITORY:-paseo-gateway}"
    --set-string "image.tag=${CHART_GATEWAY_TAG:-chart-ci}"
    --set-string "workspace.image=${CHART_WORKSPACE_IMAGE:-paseo-workspace:chart-ci}")
fi
helm upgrade --install paseo "$CHART_PACKAGE" "${install_args[@]}" --wait --timeout 5m
install_revision="$(helm status paseo --kube-context "$context" --namespace "$namespace" --output json | jq -r '.version')"
[[ "$install_revision" =~ ^[0-9]+$ ]]
kc rollout status deployment/paseo-gateway --timeout=180s
if [[ "${CHART_USE_PACKAGE_DEFAULTS:-0}" == 1 ]]; then
  [[ "$(kc get deployment paseo-gateway -o jsonpath='{.spec.template.spec.containers[0].image}')" == "$CHART_EXPECT_GATEWAY_IMAGE" ]]
  [[ "$(kc get deployment paseo-gateway -o json | jq -r '.spec.template.spec.containers[0].env[] | select(.name == "WORKSPACE_IMAGE") | .value')" == "$CHART_EXPECT_WORKSPACE_IMAGE" ]]
fi
[[ "$(kc auth can-i create pods --as "system:serviceaccount:$namespace:paseo-gateway")" == yes ]]
if [[ "$(kubectl --context "$context" --namespace default auth can-i create pods --as "system:serviceaccount:$namespace:paseo-gateway")" == yes ]]; then
  echo 'Gateway ServiceAccount can create pods outside its namespace' >&2
  exit 1
fi

cat > "$workdir/project.yaml" <<EOF
apiVersion: paseo-gateway.manziman.github.io/v1alpha1
kind: PaseoCredentialProfile
metadata:
  name: chart-public
  namespace: $namespace
spec: {}
---
apiVersion: paseo-gateway.manziman.github.io/v1alpha1
kind: PaseoProject
metadata:
  name: chart-public
  namespace: $namespace
spec:
  displayName: Chart public fixture
  repository: https://github.com/octocat/Hello-World.git
  revision: HEAD
  credentialProfile: chart-public
EOF
kc apply -f "$workdir/project.yaml"
cat > "$workdir/invalid-project.yaml" <<EOF
apiVersion: paseo-gateway.manziman.github.io/v1alpha1
kind: PaseoProject
metadata:
  name: chart-invalid
  namespace: $namespace
spec:
  displayName: Invalid fixture
  repository: https://github.com/octocat/Hello-World.git
  revision: HEAD
  credentialProfile: INVALID_NAME
EOF
if kc apply --dry-run=server -f "$workdir/invalid-project.yaml" >/dev/null 2>&1; then
  echo 'CRD admission accepted an invalid project' >&2
  exit 1
fi

cat > "$workdir/retained.yaml" <<EOF
apiVersion: paseo-gateway.manziman.github.io/v1alpha1
kind: PaseoWorkspace
metadata:
  name: chart-retained
  namespace: $namespace
spec:
  projectRef: chart-public
  displayName: Chart retained fixture
  credentialProfile: chart-public
  revision: HEAD
  residency: Running
  retentionPolicy:
    storage: Retain
EOF
kc apply -f "$workdir/retained.yaml"
wait_field paseoworkspace chart-retained .status.phase Ready 360
retained_pvc="$(kc get paseoworkspace chart-retained -o jsonpath='{.status.pvcName}')"
[[ -n "$retained_pvc" ]]
if [[ "${CHART_USE_PACKAGE_DEFAULTS:-0}" == 1 ]]; then
  [[ "$(kc get pod "$retained_pvc" -o jsonpath='{.spec.containers[0].image}')" == "$CHART_EXPECT_WORKSPACE_IMAGE" ]]
  [[ "$(kc get pod "$retained_pvc" -o jsonpath='{.spec.initContainers[0].image}')" == "$CHART_EXPECT_WORKSPACE_IMAGE" ]]
fi
retained_uid="$(kc get pvc "$retained_pvc" -o jsonpath='{.metadata.uid}')"
kc exec "pod/$retained_pvc" -c daemon -- sh -c 'printf chart-smoke-marker > /home/paseo/chart-smoke.txt'

kc patch paseoworkspace chart-retained --type merge -p '{"spec":{"residency":"Suspended"}}'
wait_field paseoworkspace chart-retained .status.phase Suspended 240
kc wait --for=delete "pod/$retained_pvc" --timeout=180s
kc patch paseoworkspace chart-retained --type merge -p '{"spec":{"residency":"Running"}}'
wait_field paseoworkspace chart-retained .status.phase Ready 360
assert_retained

# CRD apply is the documented upgrade procedure; Helm alone does not upgrade it.
if [[ "${CHART_SKIP_CRD_APPLY:-0}" == 1 ]]; then
  kubectl --context "$context" diff -f "$chart_dir/crds/"
else
  kubectl --context "$context" apply --server-side -f "$chart_dir/crds/"
fi
helm upgrade paseo "$CHART_PACKAGE" "${install_args[@]}" \
  --set-string gateway.name='Chart upgraded gateway' --wait --timeout 5m
kc rollout status deployment/paseo-gateway --timeout=180s
assert_retained
helm rollback paseo "$install_revision" --kube-context "$context" --namespace "$namespace" --wait --timeout 5m
kc rollout status deployment/paseo-gateway --timeout=180s
assert_retained
bash "$chart_dir/files/bootstrap-secrets.sh" --context "$context" --namespace "$namespace"
assert_retained

# Keep the single-node test under the available memory budget while exercising
# additional workspace storage modes.
kc patch paseoworkspace chart-retained --type merge -p '{"spec":{"residency":"Suspended"}}'
wait_field paseoworkspace chart-retained .status.phase Suspended 240
kc wait --for=delete "pod/$retained_pvc" --timeout=180s

cat > "$workdir/ephemeral.yaml" <<EOF
apiVersion: paseo-gateway.manziman.github.io/v1alpha1
kind: PaseoWorkspace
metadata:
  name: chart-ephemeral
  namespace: $namespace
spec:
  projectRef: chart-public
  displayName: Chart ephemeral fixture
  credentialProfile: chart-public
  revision: HEAD
  residency: Running
  retentionPolicy:
    storage: Ephemeral
    ttlAfterArchivedSeconds: 0
EOF
kc apply -f "$workdir/ephemeral.yaml"
wait_field paseoworkspace chart-ephemeral .status.phase Ready 360
ephemeral_name="$(kc get paseoworkspace chart-ephemeral -o jsonpath='{.status.pvcName}')"
if [[ -n "$ephemeral_name" ]] && kc get pvc "$ephemeral_name" >/dev/null 2>&1; then
  echo 'Ephemeral workspace unexpectedly created a PVC' >&2
  exit 1
fi
kc patch paseoworkspace chart-ephemeral --type merge -p '{"spec":{"residency":"Archived"}}'
wait_field paseoworkspace chart-ephemeral .status.phase Archived 360
wait_nonempty paseoworkspace chart-ephemeral .status.storageDeletedAt 360
[[ "$(kc get pvc -o json | jq --arg pvc "$retained_pvc" '[.items[] | select(.metadata.name != $pvc)] | length')" == 0 ]]

cat > "$workdir/held.yaml" <<EOF
apiVersion: paseo-gateway.manziman.github.io/v1alpha1
kind: PaseoWorkspace
metadata:
  name: chart-held
  namespace: $namespace
spec:
  projectRef: chart-public
  displayName: Chart finalizer fixture
  credentialProfile: chart-public
  revision: HEAD
  residency: Running
  retentionPolicy:
    storage: Retain
    ttlAfterArchivedSeconds: 0
EOF
kc apply -f "$workdir/held.yaml"
wait_field paseoworkspace chart-held .status.phase Ready 360
held_pvc="$(kc get paseoworkspace chart-held -o jsonpath='{.status.pvcName}')"
[[ -n "$held_pvc" ]]
finalizer='paseo-gateway.manziman.github.io/chart-smoke-hold'
kc patch pvc "$held_pvc" --type=json -p "[{\"op\":\"add\",\"path\":\"/metadata/finalizers/-\",\"value\":\"$finalizer\"}]"
kc patch paseoworkspace chart-held --type merge -p '{"spec":{"residency":"Archived"}}'
wait_nonempty pvc "$held_pvc" .metadata.deletionTimestamp 360
sleep 5
if [[ -n "$(kc get paseoworkspace chart-held -o jsonpath='{.status.storageDeletedAt}')" ]]; then
  echo 'Storage was marked deleted while the PVC finalizer still held it' >&2
  exit 1
fi
index="$(kc get pvc "$held_pvc" -o json | jq --arg hold "$finalizer" '.metadata.finalizers | index($hold)')"
[[ "$index" =~ ^[0-9]+$ ]]
kc patch pvc "$held_pvc" --type=json -p "[{\"op\":\"remove\",\"path\":\"/metadata/finalizers/$index\"}]"
wait_nonempty paseoworkspace chart-held .status.storageDeletedAt 360
kc patch paseoworkspace chart-retained --type merge -p '{"spec":{"residency":"Running"}}'
wait_field paseoworkspace chart-retained .status.phase Ready 360
assert_retained

if [[ "${CHART_NEGATIVE:-0}" == 1 ]]; then
  if helm upgrade paseo "$CHART_PACKAGE" "${install_args[@]}" \
    --set-string image.tag=chart-ci-missing --atomic --wait --timeout 45s >/dev/null 2>&1; then
    echo 'A broken gateway image unexpectedly passed the upgrade readiness gate' >&2
    exit 1
  fi
  kc rollout status deployment/paseo-gateway --timeout=180s
  assert_retained
  if helm upgrade paseo "$CHART_PACKAGE" "${install_args[@]}" \
    --set-string gateway.identitySecret=chart-missing --atomic --wait --timeout 45s >/dev/null 2>&1; then
    echo 'An upgrade with a missing identity Secret unexpectedly passed readiness' >&2
    exit 1
  fi
  kc rollout status deployment/paseo-gateway --timeout=180s
  assert_retained
fi

echo 'PASS candidate chart install, CRD admission, RBAC, workspace lifecycle, upgrade, rollback, retained Secrets and PVC data'
