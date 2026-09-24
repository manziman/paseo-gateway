# Security

This experimental gateway supports one trusted owner and project/profile-scoped
workspace credentials in one namespace. It is not a multi-tenant sandbox. Agents
can execute code and access credentials projected into their workspace. Do not run untrusted repositories or
grant untrusted users gateway access.

Gateway and backend passwords and the scoped-token signing key are separate
retained Secrets. Workers receive short-lived grants rather than the owner
password or signing key; origin archival, scope changes and expiry revoke access.
Direct WebSocket
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

For a vulnerability, use [GitHub private vulnerability
reporting](https://github.com/manziman/paseo-gateway/security/advisories/new).
Never post credentials, private code, prompt contents, or an active exploit
against someone else's installation in a public issue. Only the pinned experimental
configuration and the latest published experimental release are under active
development. Earlier releases receive no promised security backports, and no
security response SLA is offered. Check the release notes for each version's
tested support envelope before deployment.

Pull requests run CodeQL on JavaScript/TypeScript and GitHub Actions workflows,
dependency review, and the existing production npm audit. Dependency review
blocks newly introduced high or critical advisories in runtime, development,
and unknown scopes. A reviewed exception must name the specific GHSA, affected
package/version, reason, owner, and expiry in a PR; avoid broad allowlists.
CodeQL analysis failures block merging when its named checks are required.
Repository code-scanning merge protection blocks newly introduced high or
critical security alerts. A successful analyzer run alone does not mean it
found no alerts; review lower-severity findings and documented false positives.
The container scan policy and image SBOMs are documented with the release
pipeline. See [redistribution inventory](docs/redistribution.md) for the
separate license and vendor-terms review.
