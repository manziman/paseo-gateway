#!/usr/bin/env bash
set -euo pipefail
for tool in node npm docker kubectl helm; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
node -e 'if (process.versions.node.split(".")[0] !== "24") process.exit(1)' || {
  echo 'Use Node 24 (nvm use).' >&2; exit 1;
}
docker info --format 'Docker server: {{.ServerVersion}}'
# Docker Desktop kind requires the containerd image store for local image sharing.
if ! docker info --format '{{json .DriverStatus}}' | node -e '
let data = ""; process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", () => process.exit(data.includes("io.containerd.snapshotter") ? 0 : 1));'; then
  echo 'Enable Docker Desktop Settings > General > Use containerd for pulling and storing images, then Apply.' >&2
  echo 'This local setup requires the containerd image store. Existing classic-store images remain on disk.' >&2
  exit 1
fi
if ! kubectl --context docker-desktop get nodes --request-timeout=10s; then
  echo 'Enable Kubernetes in Docker Desktop settings. No other context will be used.' >&2
  exit 1
fi
# Check space inside Docker's VM; free space on the Mac is a different filesystem.
for node_name in $(kubectl --context docker-desktop get nodes -o jsonpath='{.items[*].metadata.name}'); do
  kubectl --context docker-desktop get --raw "/api/v1/nodes/${node_name}/proxy/stats/summary" --request-timeout=10s | node -e '
let data = ""; process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", () => {
  const available = JSON.parse(data).node?.fs?.availableBytes;
  if (typeof available !== "number") { console.error("Cannot determine Docker node disk space"); process.exit(1); }
  console.log(`Docker node free disk: ${(available / 1024 ** 3).toFixed(1)} GiB`);
  if (available < 15 * 1024 ** 3) {
    console.error("Need at least 15 GiB free inside Docker. Increase Settings > Resources > Advanced > Disk usage limit. No volumes were pruned.");
    process.exit(1);
  }
});'
done
kubectl --context docker-desktop get storageclass
echo 'Local prerequisites are ready. The current kubectl context has not been changed.'
