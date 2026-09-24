# Release and support policy

## Experimental channel

The first public channel is `alpha`, beginning at `1.0.0-alpha.1`. This is a
SemVer prerelease, not a stable 1.0 support promise. The existing package version
`0.1.0-poc.1` and old non-Conventional Git history are development history and are
not rewritten or fabricated into released tags. Stable publication from `main`
is disabled until deliberately enabled by a reviewed change.

Official semantic-release tooling analyzes Conventional Commit squash subjects.
`fix` and `perf` trigger patch releases, `feat` triggers minor releases, and `!`
or `BREAKING CHANGE` footers declare breaking changes. Prerelease counters and
version transitions are computed by semantic-release. Ordinary docs, tests and
development chores do not publish. Shipped image/chart/runtime dependency fixes
must use a release-worthy subject; consult the release configuration for explicit
dependency rules. Intermediate contributor commits need not be rewritten.

One product version identifies the Git tag, GitHub release, two container images,
OCI chart version/appVersion and gateway runtime. Upstream Paseo and provider
versions remain separate compatibility pins. No npm package is published and no
generated version-bump commit is pushed to a protected branch.

## Supported scope

Alpha releases target self-managed, headless CLI/SDK deployments with one active
gateway per namespace. Docker Desktop is the live-qualified Kubernetes provider.
Use the exact chart, architecture and image digests in the release record. Kind
CI validates the declared Kubernetes/Helm matrix; it does not establish production
CSI, networking, failover or EKS support.

Claude is the live-tested provider. Codex and OpenCode are pinned runtime options,
but authenticated provider parity is not claimed until separately verified.
Shared rotating Codex OAuth files, HA, complete desktop attachment/voice/plugin
parity and Agent Sandbox adoption remain outside this release. The original
specification's full acceptance bar and issues #16, #22 and #26 remain in force
for a future full-parity claim. Alpha publication does not close those gaps.

Workspace loss can interrupt a turn. The gateway does not replay uncertain
mutations or prompts. Retained PVCs do not by themselves provide node fencing or
backups. See [operations](operations.md) and [compatibility](compatibility.md).

## Security and maintenance

Only the newest published alpha is actively maintained; upgrade after reviewing
release notes and CRD/data compatibility. There is no production SLA or guaranteed
backport window. Report vulnerabilities privately using [SECURITY.md](../SECURITY.md).
Security updates pass the same required checks and artifact scans as other changes.
Images and their bundled third-party programs retain their own licenses/terms.

PRs require passing type, lint, unit, CLI, upstream, chart and security checks.
Conventional titles are checked on creation and edits. The sole maintainer may
merge their own PR after checks pass; zero mandatory external approvals avoids
an unusable self-approval requirement. Branch deletion/force pushes and release
tag updates/deletion are blocked. An emergency settings change is an explicit
administrative action, not a standing bypass for normal publication.

## Artifact consumption

Public locations are `ghcr.io/manziman/paseo-gateway`,
`ghcr.io/manziman/paseo-workspace`, and
`oci://ghcr.io/manziman/charts/paseo-kubernetes`. Named releases include immutable
digests, checksums, chart and CRDs, provenance/SBOM evidence and source revision.
Do not infer package visibility from the public source repository; qualification
includes anonymous pulls with empty registry credential configuration.

Follow [public installation](public-installation.md). Publication can partially
fail between registries and GitHub; only a complete, qualified release is advertised
as deployable. Recovery retains the original version and source and refuses to
replace published artifacts with different bytes.
