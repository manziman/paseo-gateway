# Public release guidance

Research date: 2026-09-24. This is a release-design assessment, not an implemented pipeline or a verification of GitHub settings, published artifacts, or cluster behavior. Requirements below are recommendations for this project's first independently deployable public release; they are not all registry protocol requirements.

## Recommended release contract

Use one gateway release SemVer for the Git tag, gateway image, workspace image, chart `version`, and quoted chart `appVersion`. Keep upstream Paseo compatibility (`0.9.1` currently) as separate dependency/compatibility metadata. This is a project simplification, not a Helm requirement: Helm treats `appVersion` as informational and independent of chart `version`. The local baseline is package `0.1.0-poc.1`, chart `version: 0.1.0`, and chart `appVersion: 0.1.0-poc.1`. [Helm chart fields](https://docs.helm.sh/docs/v3/topics/charts/)

Choose the first version deliberately. With no prior release, semantic-release's documented stable workflow starts at `1.0.0`; setting the package or chart version to `0.1.0` does not select that first stable version. Its FAQ explicitly says an initial `0.0.1` is unsupported and recommends prereleases for projects still undergoing frequent breaking changes. Prefer a supported prerelease branch if the POC is not ready for a stable contract. Treat a requirement to remain on `0.x` as a tooling-policy decision, not a reason to invent historical tags or rewrite semantic-release's version algorithm. [Initial stable release](https://semantic-release.org/recipes/release-workflow/pre-releases/), [initial version FAQ](https://semantic-release.org/support/faq/)

For an experimental channel, a valid simple branch configuration is `branches: ["main", { name: "alpha", prerelease: true }]`, with both branches present. semantic-release requires at least one ordinary release branch; a configuration containing only a prerelease branch is invalid. Initially run publication only on `alpha`, keeping stable publication on `main` disabled until deliberately enabled. The first no-history alpha release computes as `1.0.0-alpha.1`; review it with the locked tool's dry-run before activation. The branch/channel policy remains a design decision, not a change performed by this assessment. [Branch requirements](https://semantic-release.org/foundation/workflow-configuration/), [version calculation](https://github.com/semantic-release/semantic-release/blob/master/lib/get-next-version.js), [initial version constants](https://github.com/semantic-release/semantic-release/blob/master/lib/definitions/constants.js)

## Needed for the first deployable public release

| Requirement | Concrete acceptance evidence |
| --- | --- |
| Trusted validation | A release commit passes the repository checks, builds both image targets, and validates the packaged chart and its rendered image references. |
| Complete artifact set | Gateway image, workspace image, and OCI chart exist for the same release version; the chart's defaults resolve to those published artifacts. |
| Public consumption | Fresh unauthenticated clients can pull both images and the chart. A public source repository alone does not establish this. |
| Traceability | GitHub release identifies the source commit, version, artifact locations and image/chart digests, upstream compatibility, supported architecture(s), and installation command. |
| Safe publication | Only trusted release-branch code receives write permissions; concurrent release attempts are serialized; incomplete publications are identified and recoverable. |
| Honest readiness claim | Document prerequisites and limitations. A rendered chart proves packaging, not successful installation; a deployment claim requires an actual install/smoke result in an authorized disposable environment. |

The table is the proposed project acceptance contract. The mechanics and pitfalls supporting it follow.

### Versioning and release orchestration

- Use the official `@semantic-release/commit-analyzer`, `@semantic-release/release-notes-generator`, and `@semantic-release/github` plugins. Keep npm publication disabled for this private application package. Use the official `@semantic-release/exec` hook only for the small amount of glue needed to run Docker/Helm commands with `nextRelease.version`; do not implement a second commit parser or version calculator. [Official exec plugin](https://github.com/semantic-release/exec), [non-npm releases](https://semantic-release.org/support/faq/)
- Default analysis releases `feat` as minor, `fix`/`perf` as patch, and breaking changes as major; ordinary `chore`, `docs`, or `test` changes do not automatically release. Ensure squash commit messages preserve the chosen convention. Classify deployable chart/runtime fixes accordingly, or use explicit documented release rules. If choosing the `conventionalcommits` preset, configure analyzer and notes consistently and install the preset. [Commit analyzer configuration and rules](https://github.com/semantic-release/commit-analyzer)
- Keep all artifact publication in the same trusted release workflow/run. `GITHUB_TOKEN`-created tags/releases do not trigger a second `push`/`release` workflow. Avoid adding a long-lived PAT solely to work around this. [GitHub workflow triggering rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)
- Use semantic-release dry-run to review the computed version and notes, but test packaging independently: dry-run skips `prepare`, `publish`, `addChannel`, `success`, and `fail` and still verifies push permission. Thus it is not a publication rehearsal. Keep the chosen semantic-release release and plugins locked, and verify their Node engine requirements in the Node 24 release job. [Dry-run behavior](https://semantic-release.org/usage/configuration/), [Node requirements](https://semantic-release.org/support/node-version/)
- Avoid committing generated version/changelog changes back to the protected branch unless there is a concrete consumer need. Tags and GitHub releases supply the release record; semantic-release itself warns that release commits introduce branch-protection and consistency complexity. [Version/changelog FAQ](https://semantic-release.org/support/faq/)

### GHCR publication and visibility

Use the repository `GITHUB_TOKEN` for GHCR publication and grant `packages: write` only to the publishing job. New GHCR packages default to private. Workflow publication links packages to the repository; pre-existing packages may require their Actions access/linkage to be fixed before that token can publish. Include `org.opencontainers.image.source` on images. For reproducible consumption, record the returned content digests as well as version tags. [GHCR authentication, first publication, and digest pulls](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

Plan a first-publication visibility step for **each** package, including the OCI chart. Linked packages inherit repository access permissions, not repository visibility. An administrator must establish public package visibility; public GHCR packages then support anonymous pulls. Verify that behavior with an isolated empty registry credential configuration rather than a developer's authenticated Docker/Helm session. The verification method is a recommendation based on GitHub's documented access model. [Package visibility and anonymous access](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

For the GitHub release, grant `contents: write`. The GitHub plugin additionally needs issue/PR write permissions for its default comments; prefer disabling success comments, failure issues, and related labels if those features are unnecessary, rather than granting unrelated write scopes. [GitHub plugin permissions and options](https://github.com/semantic-release/github)

### Helm packaging

Use the built-in command `helm package charts/paseo --version "$RELEASE_VERSION" --app-version "$RELEASE_VERSION"`. This sets the packaged metadata without a custom YAML-version rewrite or a version-bump commit. Image-tag defaults still need to derive from the packaged app version or be prepared explicitly; `--app-version` does not rewrite arbitrary values. [Helm package flags](https://docs.helm.sh/docs/v3/helm/helm_package/), [appVersion semantics](https://docs.helm.sh/docs/v3/topics/charts/)

Use `helm registry login` and built-in `helm push`. The push destination is a parent namespace such as `oci://ghcr.io/OWNER/charts`, without chart basename or tag. Helm derives the basename from `name` and the tag from chart `version`. The current chart would therefore publish beneath `.../charts/paseo-kubernetes`. Consumers include that basename and select `--version`. OCI chart tags must match SemVer; there is no chart `latest` tag. Helm maps SemVer `+` build metadata to `_` in registry tags. [Helm OCI rules and commands](https://docs.helm.sh/docs/v3/topics/registries/)

### Public CI trust boundary

Run fork contributions through ordinary `pull_request` validation with read-only permissions and no publication secrets. Do not use `pull_request_target` to check out and execute fork code, including dependency installation or build scripts. Likewise, do not execute untrusted PR artifacts in a privileged follow-up workflow. [GitHub's fork-PR security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)

Pin external actions to verified full-length upstream commit SHAs, with readable version comments and an update process. GitHub identifies full-SHA pinning as the immutable action reference; mutable major/version tags are not equivalent. Default workflow permissions to read-only and grant individual jobs only the privileges they use. [GitHub secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use)

## Useful maturity features, not prerequisites for pulling and installing

- **BuildKit provenance and SBOM:** low-effort additions worth including with the initial pipeline. Docker's build action supports `provenance: mode=max` and `sbom: true`; SBOM is not automatic. Provenance defaults vary with repository visibility, and `load: true` does not retain these registry attestations. Never pass build secrets through build arguments because public-repository provenance can expose them. [Docker attestation support](https://docs.docker.com/build/ci/github-actions/attestations/)
- **GitHub signed artifact attestations:** add verifiable workflow identity for image digests and/or the chart archive. The current official action is `actions/attest` (pin its verified SHA). Container attestations require `id-token: write`, `attestations: write`, `contents: read`, and `packages: write`; the subject is the fully qualified image name without a tag plus its SHA256 digest. SBOM attestation consumes an existing SBOM; it does not generate one. Publish consumer verification instructions if enabled. [GitHub artifact/SBOM attestation guide](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- **Additional hardening:** chart signing, vulnerability/license policy, multi-architecture publication, digest-pinned chart defaults, automated update tooling, and richer release verification can follow according to consumer needs. Multi-architecture support becomes a first-release requirement only if those architectures are promised. Helm supports provenance uploads and optional Sigstore tooling; neither is required for basic OCI publishing. [Helm OCI signing options](https://docs.helm.sh/docs/v3/topics/registries/)

## Keep the implementation small

Prefer one release configuration, one trusted release workflow, official plugins, Docker's maintained build tooling, and native Helm commands. The unavoidable glue should pass the already-computed version and artifact digests, order publication, and report failures. Do not parse human-readable dry-run output to calculate a version, manufacture a prior release, commit release-generated manifests, or create a custom multi-registry release framework for the first deployment.

Publication spans Git, GitHub Releases, and several registry artifacts; treat partial failure as a real operational state. Define the recovery procedure before enabling automatic publication, and require complete artifact verification before advertising a release as deployable. This is a design recommendation, not a claim that semantic-release provides an atomic cross-registry transaction.
