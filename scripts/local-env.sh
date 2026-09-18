# Shared local namespace selection; source this before any cluster mutation.
export PASEO_NAMESPACE="${PASEO_NAMESPACE-paseo-system}"
if [[ ! "$PASEO_NAMESPACE" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || (( ${#PASEO_NAMESPACE} > 63 )); then
  echo 'PASEO_NAMESPACE must be a valid Kubernetes namespace (1-63 lowercase letters, digits, or hyphens).' >&2
  exit 1
fi
