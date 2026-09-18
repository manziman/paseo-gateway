#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/local-env.sh
bash scripts/doctor.sh
node --import tsx scripts/check-api-upgrade.ts
npm run check
npm run generate:crds
helm lint charts/paseo
# Unique tags prevent kind's cached IfNotPresent images from hiding local source changes.
image_tag="dev-$(date +%Y%m%d%H%M%S)-${RANDOM}"
docker build --tag "paseo-gateway:${image_tag}" --tag paseo-gateway:dev .
docker build --file docker/workspace.Dockerfile --tag "paseo-workspace:${image_tag}" --tag paseo-workspace:dev .
# Docker Desktop shares locally built images through its containerd image store.
kubectl --context docker-desktop create namespace "$PASEO_NAMESPACE" --dry-run=client -o yaml |
  kubectl --context docker-desktop apply -f -
kubectl --context docker-desktop label namespace "$PASEO_NAMESPACE" pod-security.kubernetes.io/enforce=restricted --overwrite
node --import tsx scripts/identity.ts
kubectl --context docker-desktop apply -f charts/paseo/crds/
helm upgrade --install paseo charts/paseo --kube-context docker-desktop --namespace "$PASEO_NAMESPACE" --set-string "image.tag=${image_tag}" --set-string "workspace.image=paseo-workspace:${image_tag}" --wait --timeout 3m
kubectl --context docker-desktop --namespace "$PASEO_NAMESPACE" rollout status deployment/paseo-gateway --timeout=3m
kubectl --context docker-desktop --namespace "$PASEO_NAMESPACE" apply -f deploy/examples/project.yaml
echo 'Gateway installed. Import a Claude token with npm run credentials, then npm run dev:connect.'
