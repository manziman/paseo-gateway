# Encrypted gateway and workspace transport

TLS is opt-in so existing Docker Desktop installations retain their connection
settings. Enable `transport.tls.enabled` for remote deployments. The gateway then
serves HTTPS/WSS on 8080, connects to workspace Services using verified WSS, and
supplies the secure gateway address to the in-pod CLI. Bearer authentication and
project/profile authorization still apply; TLS does not replace them.

Provision two retained Secrets before enabling TLS:

| Chart setting | Secret contents | Certificate names |
| --- | --- | --- |
| `transport.tls.gatewaySecret` | `tls.crt`, `tls.key`, `ca.crt` | `paseo-gateway.NAMESPACE.svc` plus the actual client-facing DNS name |
| `transport.tls.workspaceSecret` | `tls.crt`, `tls.key`, `ca.crt` | `*.NAMESPACE.svc`, matching the generated workspace Services |

The gateway Secret's `ca.crt` trusts workspace server certificates. The workspace
Secret's `ca.crt` trusts the gateway server certificate. Prefer separate issuance
and trust bundles for these two roles: a workspace certificate must not be trusted
as the gateway's identity. The private CA signing keys belong in the operator's
certificate system, never these Secrets. Do not disable certificate verification.
The daemon receives only the gateway CA, not the workspace TLS private key.
The dedicated TLS proxy container receives the workspace server key. This is a
single trusted-owner deployment; the shared workspace certificate is not a
multi-tenant identity system or mutual TLS.

The upstream Paseo daemon listens only on `127.0.0.1:6767` inside its Pod. A small
Node TLS proxy streams bytes to that fixed listener with backpressure; it does
not change the upstream protocol or select remote destinations. Service port
6767 maps to proxy port 6768, and the chart's workspace ingress policy permits the
TLS port from the gateway. The plaintext port is not reachable over the Pod IP.
Both the gateway and proxy require TLS 1.2 or later. Custom workspace images must
include the supplied `/opt/paseo/tls-proxy.mjs` script.

The proxy reloads projected certificate pairs every 30 seconds, retaining its
last valid pair if a replacement is invalid. Gateway certificates and Node's
`NODE_EXTRA_CA_CERTS` trust bundle are loaded at process startup. Roll the gateway
and affected workspace Pods when rotating trust roots; stage overlapping trust
before replacing leaf certificates. Gateway replacement preserves workspace
execution, but replacing a workspace interrupts its running processes. An expired
certificate fails verification rather than falling back to plaintext.

An unchanged CLI can use `--host 'tcp://HOST:8080?ssl=true'`. Install the issuing CA
in the client's trust store (or set `NODE_EXTRA_CA_CERTS` for a Node-based CLI).
Use direct port-forwarding only with a certificate name that the client can
validate. Health probes use HTTPS; Kubernetes probe certificate behavior does not
establish client verification, so acceptance separately tests trusted and
untrusted certificates and hostname mismatches.

NetworkPolicy enforcement, permitted private egress, external ingress termination
and CSI node-failure fencing still require their own platform acceptance. See
[EKS qualification](eks-qualification.md). A TLS setting or an encrypted-volume
flag alone is not evidence that those tests passed.

Sources: [Node TLS](https://nodejs.org/api/tls.html),
[Node extra CA certificates](https://nodejs.org/api/cli.html#node_extra_ca_certsfile),
[Kubernetes Secret projections](https://kubernetes.io/docs/concepts/configuration/secret/).
