#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local-env.sh"
local_port="${PASEO_LOCAL_PORT-6768}"
if [[ ! "$local_port" =~ ^[1-9][0-9]{0,4}$ ]] || (( local_port > 65535 )); then
  echo 'PASEO_LOCAL_PORT must be an integer between 1 and 65535.' >&2
  exit 1
fi
echo "Add a direct host in Paseo Desktop: 127.0.0.1:${local_port} (namespace ${PASEO_NAMESPACE})."
echo "Get the password in your own terminal: kubectl --context docker-desktop -n ${PASEO_NAMESPACE} get secret paseo-identity -o jsonpath='{.data.password}' | base64 --decode"
exec kubectl --context docker-desktop --namespace "$PASEO_NAMESPACE" port-forward --address 127.0.0.1 service/paseo-gateway "${local_port}:8080"
