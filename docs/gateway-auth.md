# Gateway identity and scoped workspace credentials

The retained owner bearer password still authenticates unchanged desktop/CLI
clients. A separate retained signing key and retained server ID (the token
audience) enable scoped workspace credentials. Never reuse the owner password,
upstream daemon password, or a provider credential as the signing key. Gateway
startup rejects reuse of its owner/backend credentials and keys shorter than 32
bytes. Generate a random key; length checking alone does not establish entropy.

`ServerOptions.scopedAuth` enables verification and the owner-only
`POST /auth/workspace-token` endpoint. Its JSON body is
`{"workspaceId":"one","ttlSeconds":3600}`; TTL defaults to one hour and is
bounded to 24 hours. The response contains `token` and `expiresIn` and sets
`Cache-Control: no-store`. The endpoint derives the project, credential profile,
origin name, and origin UID from the current Kubernetes workspace. Unknown body
fields are rejected. A workspace bearer cannot call this endpoint to renew,
expand its scope, or mint owner credentials. A trusted controller can call
`issueWorkspaceToken` directly for automatic renewal and Secret projection.

HTTP and WebSocket use the same parser: `Authorization: Bearer ...` takes
precedence over the browser WebSocket `paseo.bearer.<token>` subprotocol. Malformed
explicit headers do not fall back to the subprotocol. Protected endpoints and
WebSocket upgrades enforce allowed Host and Origin values. Health and readiness
remain unauthenticated probes. Externally exposed traffic requires TLS termination;
bearer values must not be included in logs, URLs, command output, or CR status.

Tokens have the `pgw1.<base64url claims>.<HMAC-SHA256 signature>` wire format.
Claims are strictly validated, explicitly workspace-only, bound to an audience,
and include issuance/expiry times and a random token ID. Signatures and owner
credentials use fixed-length constant-time digest comparisons. The token is a
credential, not encrypted data: its scope is readable by its holder.

Scope is the intersection of permitted project IDs and credential profiles.
Orchestrators may create and observe sibling workers in that project and role;
they cannot select another project/profile, manage projects, or read Kubernetes
Secrets. Scoped server information advertises workspace permissions only. Session
inventory filtering and workspace routing enforce scope, including binary routes.
The authoritative origin UID must still match a Running, nondeleted workspace;
recreating the same name does not revive an old token. Suspending or archiving the
origin revokes it. JSON/binary operations recheck authorization; sockets also check
expiry/revocation on messages and periodically close revoked idle connections.
Already dispatched backend work is not rolled back by revocation.

Token expiry requires rereading the projected Secret and reconnecting with its
renewed value. Secret volume updates are asynchronous: wrappers should read the
file for each command rather than copy the token into a long-lived environment
variable or use a subPath mount. The controller must renew before expiry and
restrict the Secret to that origin pod. It must never mount the signing key or
owner password in workspace pods. See Kubernetes' [Secret volume update
behavior](https://kubernetes.io/docs/concepts/configuration/secret/#using-secrets-as-files-from-a-pod).

For emergency global revocation, replace the retained signing key and restart
gateway processes so the old key is no longer accepted, then renew projected
workspace tokens. There is deliberately no previous-key acceptance window.
`revokedTokenIds` supports targeted process-local revocation; it is not a durable
cluster revocation registry. Origin lifecycle/UID checks provide durable revocation
without that registry. Key rotation leaves the owner password and server ID intact.

`ServerOptions.advertised.name` configures the visible hostname while retaining the
`(independent)` attribution. The typed server-info builder validates its input and
protocol payload. It derives permissions from the principal and fixes capabilities
to implemented behavior; unsupported capability overrides fail validation. It
does not expose decorative feature toggles that leave behavior enabled.

`tests/auth.test.ts` covers both bearer transports, owner compatibility, scoped
issuance, audience/expiry/tampering/rotation/revocation, strict owner-escalation
rejection, origin UID reuse, role isolation, same-role worker creation through the
actual SDK, and rejected scoped minting. Live projected renewal and provider
execution are separate cluster acceptance checks.
