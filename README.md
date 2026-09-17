# Paseo Kubernetes

Run isolated Paseo workspaces on Kubernetes and expose them as one host to an
unchanged Paseo client. One TypeScript service contains the gateway and workspace
controller. Workspace pods run the version-pinned upstream Paseo daemon.

**Experimental POC, not a supported v0.1 release.** The target is two concurrent
Claude Code workspaces with retained files/history and gateway replacement.
See [compatibility and acceptance](docs/compatibility.md) for verified behavior,
limitations, and the remaining live checks.

## Local setup

Prerequisites: Node 24 (`nvm use`), npm, Docker Desktop with Kubernetes and the **containerd image store** enabled,
kubectl, Helm 3 or 4, and a Claude subscription. Local commands explicitly use the
`docker-desktop` context and namespace `paseo-system`; they never switch your
current kubectl context. Allow at least 4 CPUs, 8 GiB RAM, and 15 GiB **free inside Docker’s VM** for the
cluster, images, and two workspaces; measure and adjust for your workloads.

In Docker Desktop Settings → General, enable “Use containerd for pulling and
storing images.” Apply before building; the kind provisioner requires it.

```sh
npm ci
npm run dev:doctor
npm run dev:up
```

Generate a subscription token in your own terminal with `claude setup-token`.
Save only that token to a local file with mode `0600`, outside the repository,
then import it without putting it in command arguments or logs:

```sh
npm run credentials -- /absolute/path/to/claude-token
npm run dev:connect
```

Add a direct host in Paseo Desktop at **127.0.0.1:6768**. Retrieve its password in
your own terminal:

```sh
kubectl --context docker-desktop -n paseo-system get secret paseo-identity \
  -o jsonpath='{.data.password}' | base64 --decode
```

The configured **Hello World** project appears before a pod exists. Create two
workspaces under it. Wait for `Ready` before starting Claude agents:

```sh
kubectl --context docker-desktop -n paseo-system get paseoworkspaces -w
```

The example uses a public repository. Create additional `PaseoProject` records
from [the example](deploy/examples/project.yaml). Private Git authentication is
not implemented in this POC. Tailscale belongs to the deployment environment;
the gateway has no Tailscale integration. Use an external encrypted path for
remote access and configure `gateway.allowedHosts` for its hostname.

## Development and verification

```sh
npm run check          # strict types, lint/format, unit and socket tests, build
npm run generate:crds  # generate structural CRDs from the runtime schemas
helm lint charts/paseo
npm run test:upstream  # two real upstream Docker daemons; creates/cleans test resources
npm run test:live      # Docker Desktop Kubernetes smoke/recovery test
```

`test:upstream` does not invoke Claude or need a subscription token. The default
`test:live` uses a separate infrastructure-only profile and retains its workspaces
for inspection; set `RUN_CLAUDE_LIVE=1` to also dispatch
real Claude prompts using the imported profile. See [testing](docs/testing.md).

After editing the service, rerun `npm run dev:up` to build/load images and apply
the chart. Its rolling strategy is `Recreate`; only one gateway is supported.
Workspace agents continue during a gateway restart. Restarting a workspace pod
can interrupt its current turn; neither service replays prompts automatically.

## Layout

| Location | Responsibility |
| --- | --- |
| `src/controller` | Desired pod/service/PVC state and idempotent reconciliation |
| `src/gateway` | Direct-client protocol, aggregation, scoped IDs and backend connections |
| `src/kubernetes` | Kubernetes API adapter and test boundary |
| `src/domain.ts` | Small project/workspace records and validation |
| `charts/paseo` | CRDs, RBAC, deployment, service and network policy |
| `docker` | Pinned upstream workspace image and checkout initialization |
| `scripts` | Local setup, credentials and live tests |

Read [architecture](docs/architecture.md), [operations](docs/operations.md),
[security](SECURITY.md), [contributing](CONTRIBUTING.md), and the
[original spec](paseo-kubernetes-high-level-spec.md).

Licensed under [Apache-2.0](LICENSE). Upstream and third-party notices remain
applicable; see [NOTICE](NOTICE). This project is independent of upstream Paseo.
