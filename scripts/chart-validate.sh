#!/usr/bin/env bash
set -euo pipefail

chart="${1:-charts/paseo}"
helm lint "$chart"
helm template paseo "$chart" --namespace chart-validation \
  --set-string image.digest="sha256:$(printf 'a%.0s' {1..64})" \
  --set-string workspace.digest="sha256:$(printf 'b%.0s' {1..64})" \
  > /dev/null
helm template paseo "$chart" --namespace chart-validation \
  --set-string image.repository=local/gateway --set-string image.tag=ci \
  --set-string workspace.image=local/workspace:ci \
  --set workspace.storageSize=1Gi --set gateway.maxRunningWorkspaces=3 \
  > /dev/null

invalid=(
  'image.pullPolicy=Sometimes'
  'image.digest=sha256:bad'
  'gateway.identitySecret=Invalid_Name'
  'gateway.maxRunningWorkspaces=0'
  'workspace.storageSize=not-a-quantity'
  'unknownValue=true'
)
for setting in "${invalid[@]}"; do
  if helm template paseo "$chart" --namespace chart-validation --set "$setting" >/dev/null 2>&1; then
    echo "Expected chart values validation to reject $setting" >&2
    exit 1
  fi
done
echo 'PASS packaged chart render, representative values, and invalid-value rejection'
