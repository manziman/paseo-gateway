# Install a public release

Paseo Gateway is an independent project, not affiliated with or endorsed by Paseo.
The initial `alpha` channel is experimental. Use a named version from the
[GitHub releases](https://github.com/manziman/paseo-gateway/releases); do not deploy
a development tag. See [compatibility](compatibility.md) for verified capabilities
and [release policy](release-policy.md) for the support boundary.

## Prerequisites

The locally qualified provider is Docker Desktop Kubernetes 1.34.3 with its
containerd image store and a default dynamic StorageClass. Have `kubectl`, Helm,
`openssl`, `uuidgen`, and `tar` installed. Reserve at least 4 CPUs, 8 GiB RAM and
15 GiB free **inside Docker's VM** for the gateway and two modest workspaces.
Workspace requests and provider workloads may need more. This is one active
gateway per namespace; high availability and EKS qualification remain future work.

The installation commands explicitly target `docker-desktop`. They never switch
your current Kubernetes context. Use a new namespace for your first public
installation. An existing POC using a different API group cannot be upgraded by
renaming resources; read the [migration constraints](operations.md#api-group-transition).

## Download and install

No source checkout, npm installation or local image build is required. Replace
the version below with the selected published alpha release. Images and the chart
are public; registry login is unnecessary.

```sh
export PASEO_VERSION=1.0.0-alpha.1
helm pull oci://ghcr.io/manziman/charts/paseo-kubernetes \
  --version "$PASEO_VERSION"
tar -xzf "paseo-kubernetes-${PASEO_VERSION}.tgz"
kubectl --context docker-desktop create namespace paseo-public
bash paseo-kubernetes/files/bootstrap-secrets.sh \
  --context docker-desktop --namespace paseo-public
helm upgrade --install paseo "paseo-kubernetes-${PASEO_VERSION}.tgz" \
  --kube-context docker-desktop --namespace paseo-public \
  --wait --timeout 5m
kubectl --context docker-desktop -n paseo-public rollout status deploy/paseo-gateway
```

The packaged chart selects immutable image digests. The bootstrap script creates
only missing identity/backend/signing Secrets and keeps existing values. These
Secrets are outside the Helm release and must survive upgrades, restarts and
uninstall/reinstall. Back them up alongside workspace resources and data. Never
commit their values or include them in diagnostics. Consult the packaged README
and values schema for custom Secret names, resource limits and egress settings.

## Supply your own provider credentials

Credentials belong to the operator; images contain none. Use your own provider's
official authentication flow and applicable terms. For a Claude setup-token file
outside the checkout, created by you with `claude setup-token`:

```sh
kubectl --context docker-desktop -n paseo-public create secret generic claude-default \
  --from-file=token=/absolute/path/to/token-only-file
kubectl --context docker-desktop -n paseo-public apply -f - <<'YAML'
apiVersion: paseo-gateway.manziman.github.io/v1alpha1
kind: PaseoCredentialProfile
metadata:
  name: claude-default
spec:
  env:
    - name: CLAUDE_CODE_OAUTH_TOKEN
      valueFrom:
        secretKeyRef: {name: claude-default, key: token}
---
apiVersion: paseo-gateway.manziman.github.io/v1alpha1
kind: PaseoProject
metadata:
  name: hello-world
spec:
  displayName: Hello World
  repository: https://github.com/octocat/Hello-World.git
  revision: HEAD
  credentialProfile: claude-default
YAML
```

Do not paste tokens into shell arguments, Git, issues or chat. The file must
contain the credential only, with no trailing newline. For API keys, file
configuration, private SSH/HTTPS Git and custom runtime images, use
[credential profiles](credential-profiles.md). Shared rotating Codex subscription
logins are unsupported; see [credential renewal](credential-renewal.md).

## Connect and run

Start a local-only tunnel:

```sh
kubectl --context docker-desktop -n paseo-public port-forward \
  --address 127.0.0.1 service/paseo-gateway 6768:8080
```

Read your host password locally in another terminal:

```sh
kubectl --context docker-desktop -n paseo-public get secret paseo-identity \
  -o jsonpath='{.data.password}' | base64 --decode
```

Configure the pinned Paseo 0.9.1 CLI/SDK with the direct host `127.0.0.1:6768` and
that password. See [headless operations](mvp-operations.md) for workspace creation,
agent execution, schedules, scoped worker access and diagnostics. The gateway's
project catalog will include Hello World before any workspace Pod is created.
Remote access requires an external encrypted path, such as your existing Tailscale
deployment, and a matching `gateway.allowedHosts` setting. Tailscale is not bundled.

## Upgrade, rollback and removal

Read the target release's compatibility notes and back up custom resources,
identity/provider Secrets and PVC contents first. Download and extract the target
chart separately. Helm installs CRDs on initial install but does not update them
on upgrade. After reviewing schema compatibility, apply the target CRDs explicitly:

```sh
kubectl --context docker-desktop apply -f paseo-kubernetes/crds/
helm upgrade paseo "paseo-kubernetes-${PASEO_VERSION}.tgz" \
  --kube-context docker-desktop --namespace paseo-public --wait --timeout 5m
```

Preserve any custom values with a reviewed values file passed using `--values`;
avoid `--reuse-values`, which can retain obsolete image digests. Gateway identity
must stay unchanged. Existing workspace Pods keep their image until idle
suspend/resume; an image update must not replay an active prompt. Helm rollback
restores chart resources only. It does not roll back CRDs, provider state or PVC
data; use it only when the old controller accepts the current schema/state.

Before uninstall, suspend all workspaces and verify their Pods have stopped.
Then `helm uninstall paseo --kube-context docker-desktop -n paseo-public` removes
the gateway, but keeps manually provisioned Secrets, custom resources, CRDs and
retained PVCs. Reinstall using the same namespace and Secrets. Never delete the
namespace or CRDs as an uninstall shortcut; that can destroy retained data.
