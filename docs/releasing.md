# Maintaining public releases

The [release policy](release-policy.md) defines the experimental support envelope.
The pipeline is `.github/workflows/release.yaml`; semantic-release configuration
is `release.config.mjs`. Keep these and this runbook consistent.

## Normal release

Merge Conventional Commit PRs through the protected branches. Only `alpha`
publishes. `main` is an ordinary semantic-release branch for version calculation,
but the workflow does not publish stable releases. The first alpha is calculated
as `1.0.0-alpha.1` without fabricating an old release tag.

Publication reruns CI and the Kubernetes chart matrix on the exact release commit.
The staging job has contents/packages permissions. A separate native ARM64 job
has contents/packages/OIDC/attestation permissions. Pull-request jobs have no publication credentials. All publication
is serialized in one non-cancellable concurrency group; a `GITHUB_TOKEN`-created
tag is not expected to trigger a separate workflow.

After verifying the alpha version and source, semantic-release reserves the Git
tag before the publish hook builds and pushes
both architecture indexes, scans actual contents, packages a chart with immutable
digests, and verifies anonymous consumption before creating the draft GitHub
release. A failed artifact version keeps its tag, so a later source fix naturally
advances to the next alpha without rewriting artifacts. Existing versioned artifacts are never deliberately overwritten.
All per-platform version/CLI smoke, inventory and vulnerability checks run during
staging. AMD64 upstream daemon contracts run there too. The draft's exact image
digests then pass gateway/runtime and upstream daemon contracts on a native
`ubuntu-24.04-arm` runner before any GitHub signed attestations are produced.
The native job anchors the downloaded checksum list to the staging job output,
verifies every draft asset, signs only the expected versioned chart, attaches its
`native-arm64-verification.json` record and signed bundles, and updates checksums.
A native-test or signing failure leaves the release as an incomplete draft.
BuildKit SBOM/provenance and GitHub signed attestations accompany the image/chart
subjects. Exact revisions, digests and platform lists live in `artifacts.json`.

Release-worthy runtime/image/chart dependency changes must produce a release:
use `fix(deps)`, `fix(image)` or `fix(chart)`; `build(deps)` and `build(runtime)`
also have explicit patch rules. Development-only `ci(deps-dev)` changes do not
publish. Both analyzer and release notes use the same Conventional Commits preset.

## One-time registry bootstrap

The registry owner must check package-name ownership before first publication.
GHCR can return authorization-denied for a not-yet-created package, so the first
alpha supports an explicit, temporary `GHCR_BOOTSTRAP_PACKAGES` repository variable
listing only verified-absent repositories. The adapter additionally checks the
package API and limits this exception to alpha candidates while that one-time
allowlist remains configured. A source fix can advance the candidate version
before all three packages exist. Other authentication,
network and unexpected manifest failures remain errors.

New packages default to private even when source is public. Set all three package
settings to public: `paseo-gateway`, `paseo-workspace`, and
`charts/paseo-kubernetes` under the maintainer account. Preserve source-repository
linkage and Actions access. Remove the bootstrap variable after creation. Do not
introduce a personal publishing token merely to work around package setup.

## Qualify the draft

A successful workflow creates an **unpublished draft**, pending qualification.
An incomplete run or draft is not a deployable-release announcement. Check:

1. The release workflow succeeded on the tagged commit, including both architecture
   smoke tests, native ARM64 upstream contracts, fixed HIGH/CRITICAL vulnerability
   gates and signed attestations.
2. Download the draft assets into a fresh directory. Verify `SHA256SUMS` with
   `sha256sum -c` (or `shasum -a 256 -c` on macOS). Check version/revision/digests
   against the workflow and `artifacts.json`.
3. Use `gh attestation verify oci://ghcr.io/manziman/paseo-gateway@sha256:DIGEST
   --repo manziman/paseo-gateway`, and repeat for the workspace image. Verify the
   downloaded chart with `gh attestation verify CHART.tgz --repo
   manziman/paseo-gateway`. Compare attestation source revision and workflow with
   the release record, not just its repository owner.
4. Pull images and chart using empty Docker and Helm registry configuration.
   Install that chart into a new Docker Desktop namespace using the packaged
   bootstrap script; use its default published digests, without development tags.
5. Run credential-free lifecycle/restart/retention tests and authorized real
   provider/private Git acceptance. Keep credentials and private repository
   content out of public logs. Record exact images, chart digest, cluster/tool
   versions, results and any unverified scope in the release qualification record.
6. Attach the redacted qualification record and update release notes to link the
   installation/upgrade guide. Only then publish the existing draft, preserving
   its prerelease flag and immutable tag.

For the local chart smoke helper, use the explicitly supported Docker Desktop
mode and a new test-owned namespace. Tests must not touch another installation's
custom resources, workloads or retained volumes. The existing provider scripts
take `PASEO_NAMESPACE`; they always select `docker-desktop` explicitly.

## Recovery without rewriting a version

Publication across GitHub and OCI registries is not a transaction. Failed jobs
upload `release-evidence-*` workflow artifacts for 30 days. Download these before
rerunning so that partial state and original digests remain reviewable.

- **Git tag exists, registry publication/visibility/scan or GitHub draft/upload/attestation failed:** dispatch Release on
  `alpha` with `recover_version` set to the exact tagged alpha version. Recovery
  requires the workflow checkout to equal that tag's source and be in `alpha`
  history. It reuses matching image version/source/platform metadata, compares
  deterministic chart bytes, validates all registry artifacts again and repairs the unpublished
  draft/assets. It refuses to replace an already public GitHub release. If the
  native job already updated draft assets/checksums before a later failure, use
  this recovery dispatch rather than rerunning only that job: the original
  staging checksum anchor deliberately rejects changed draft assets.
- **Branch advanced beyond the failed tagged source:** the normal recovery
  dispatch deliberately refuses historical code execution. Diagnose and make a
  reviewed recovery change that validates the original source/evidence, or publish
  the next version. Never force-push the branch, move a protected tag, overwrite
  published versioned artifacts, or silently claim a different commit was tested.
- **An artifact defect requires a source fix:** merge the fix through the normal
  PR path. The failed candidate tag reserves its version, so semantic-release
  computes the next alpha. Leave the old version incomplete and unadvertised;
  never reuse it for different source.
- **Different bytes under an existing version:** stop. Preserve evidence and
  investigate ownership/source. Do not delete the original version as an automatic
  retry mechanism. A corrected artifact needs a new version.

`semantic-release --dry-run` verifies version calculation and notes, but skips
prepare/publish and therefore does not test registry effects. The release tests
exercise version calculation with temporary Git repositories plus artifact and
failure-path fixtures. Live publication and anonymous installation remain
separate evidence.

## Native runner prerequisite

GitHub lists `ubuntu-24.04-arm` as a standard Linux ARM64 runner for public
repositories ([runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
The credential-free `upstream-arm64` PR/CI job builds the workspace and runs the
same daemon suite on that runner before a release change can merge. Checkout,
setup-node and attest are pinned JavaScript actions; no x86-only action container
is introduced. The release job verifies the published digest again because a
pre-publication source build does not prove the exact registry artifact.
