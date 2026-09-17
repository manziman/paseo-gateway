# Security

This POC supports one trusted owner in one namespace. It is not a multi-tenant
sandbox. Agents can execute code in their workspace and access the subscription
token mounted into that pod's environment. Do not run untrusted repositories or
grant untrusted users gateway access.

Gateway and backend passwords are separate retained Secrets. Direct WebSocket
requests must authenticate, and Host/Origin checks restrict browser access.
The local port-forward binds to loopback. Remote installations must provide an
encrypted transport externally (for example Tailscale or TLS); plain WebSocket
bearer authentication does not itself encrypt traffic. The gateway-to-daemon
hop uses bearer authentication and a workspace ingress NetworkPolicy. Policies
are enforced only when the cluster CNI supports them; Docker Desktop's default
networking must not be assumed to provide that enforcement. Use network
encryption/mTLS or a suitably trusted cluster network before remote deployment.

Workspace pods run without root, privilege escalation, Linux capabilities, or
service-account tokens. The gateway uses namespaced RBAC. It can create pods
and read credential Secrets in its namespace, so compromise of the gateway is
compromise of that namespace. Keep unrelated credentials and workloads out.

Secrets are not a backup or an encryption-at-rest guarantee. Configure encryption
and backup of Secrets, custom resources and workspace volumes outside this
application. Retained PVCs are private per workspace but ReadWriteOnce is not
node-failure fencing. See [recovery constraints](docs/operations.md).

For a vulnerability, use GitHub's private vulnerability reporting if enabled on
this repository; otherwise contact `@manziman` privately before disclosing it.
Never post credentials, private code, prompt contents, or an active exploit
against someone else's installation in a public issue. Only the pinned POC
configuration is under active development; no security support SLA is offered.
