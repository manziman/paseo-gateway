#!/usr/bin/env bash
set -euo pipefail

# Creates only missing retained gateway Secrets. Requires kubectl, openssl and
# uuidgen; no Node checkout, Docker image build, or chart installation needed.
usage() {
  echo "Usage: $0 --context CONTEXT --namespace NAMESPACE [--identity-secret NAME] [--backend-secret NAME] [--signing-secret NAME]" >&2
}

context=""
namespace=""
identity_secret="paseo-identity"
backend_secret="paseo-backend"
signing_secret="paseo-signing"
while (($#)); do
  case "$1" in
    --context|--namespace|--identity-secret|--backend-secret|--signing-secret)
      key="$1"
      if (($# < 2)) || [[ -z "$2" ]]; then usage; exit 2; fi
      case "$key" in
        --context) context="$2" ;;
        --namespace) namespace="$2" ;;
        --identity-secret) identity_secret="$2" ;;
        --backend-secret) backend_secret="$2" ;;
        --signing-secret) signing_secret="$2" ;;
      esac
      shift 2
      ;;
    *) usage; exit 2 ;;
  esac
done
if [[ -z "$context" || -z "$namespace" ]]; then usage; exit 2; fi
name_pattern='^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
for name in "$namespace" "$identity_secret" "$backend_secret" "$signing_secret"; do
  if ((${#name} > 63)) || [[ ! "$name" =~ $name_pattern ]]; then
    echo "Invalid Kubernetes namespace or Secret name" >&2
    exit 2
  fi
done
if [[ "$identity_secret" == "$backend_secret" || "$identity_secret" == "$signing_secret" || "$backend_secret" == "$signing_secret" ]]; then
  echo "The three retained Secrets need distinct names" >&2
  exit 2
fi

for command in kubectl openssl uuidgen; do
  if ! command -v "$command" >/dev/null; then
    echo "$command is required" >&2
    exit 2
  fi
done
kubectl --context "$context" get namespace "$namespace" >/dev/null
umask 077
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

ensure_secret() {
  local name="$1" role="$2" encoded="" server_id="" decoded="" existing=""
  existing="$(kubectl --context "$context" --namespace "$namespace" get secret "$name" --ignore-not-found -o name)"
  if [[ -n "$existing" ]]; then
    encoded="$(kubectl --context "$context" --namespace "$namespace" get secret "$name" -o jsonpath='{.data.password}')"
    decoded="$(printf '%s' "$encoded" | openssl base64 -d -A)"
    if ((${#decoded} < 32)); then
      echo "$name exists but lacks a password of at least 32 bytes" >&2
      exit 1
    fi
    if [[ "$role" == identity ]]; then
      server_id="$(kubectl --context "$context" --namespace "$namespace" get secret "$name" -o jsonpath='{.data.serverId}')"
      if [[ -z "$server_id" ]] || [[ -z "$(printf '%s' "$server_id" | openssl base64 -d -A)" ]]; then
        echo "$name exists but lacks serverId" >&2
        exit 1
      fi
    fi
    echo "$name: retained Secret exists (values redacted)"
    return
  fi
  printf '%s' "$(openssl rand -hex 32)" > "$temp_dir/password"
  local files=("--from-file=password=$temp_dir/password")
  if [[ "$role" == identity ]]; then
    printf '%s' "$(uuidgen)" > "$temp_dir/serverId"
    files+=("--from-file=serverId=$temp_dir/serverId")
  fi
  if ! kubectl --context "$context" --namespace "$namespace" create secret generic "$name" "${files[@]}" >/dev/null; then
    # Another installer may have created it after our first read. Verify its keys.
    existing="$(kubectl --context "$context" --namespace "$namespace" get secret "$name" --ignore-not-found -o name)"
    if [[ -z "$existing" ]]; then
      echo "Could not create $name" >&2
      exit 1
    fi
    ensure_secret "$name" "$role"
    return
  fi
  kubectl --context "$context" --namespace "$namespace" patch secret "$name" --type merge -p '{"immutable":true}' >/dev/null
  echo "$name: retained Secret created (values redacted)"
}

ensure_secret "$identity_secret" identity
ensure_secret "$backend_secret" backend
ensure_secret "$signing_secret" signing
