# Public release gap assessment

Assessed 2026-09-24 against `main` at
`62a7c6b03df6e0c8be2731765029dfc4d4a00a15`, including live GitHub repository
settings. This assessment excludes the deferred Agent Sandbox spike (#27).
No repository settings, release tags, packages or deployments were changed.

## Summary

The project has a substantial development and integration-test foundation.
The missing layer is an enforced contribution and release process, plus a
self-contained public installation path. There is no automated public release
pipeline yet. This is a bounded release-engineering phase, not a project rebuild.

An experimental, versioned public release is a reasonable first target after
the gates below. A supported full-parity release is a separate claim: #22 and
#26 retain unresolved provider/credential and acceptance gaps. Publishing
artifacts must not silently redefine the documented support bar.

## Observed state

| Area | Present | Gap |
| --- | --- | --- |
| Open-source foundation | Public Apache-2.0 repo, NOTICE, README, contributing/security/conduct documents, CODEOWNERS, issue/PR templates, Dependabot | Repository description still describes specification/research; release/support policy and public install instructions need updating |
| PR CI | Strict TypeScript, Biome, unit/socket tests, build, official CLI fixtures, generated-CRD drift, Helm lint/render, npm production audit, gateway and workspace Docker builds, real upstream-daemon tests | No required merge checks; no automated Kubernetes install/upgrade test, semantic PR-title check, image scanning or CodeQL |
| Workflow security | Actions pinned to full commit SHAs, read-only default token, checkout credentials not persisted, timeouts and concurrency cancellation, PR builds do not publish | Repository allows all Actions and does not enforce SHA pinning; publishing workflow/token boundaries do not exist yet |
| Repository governance | CODEOWNERS points to maintainer; secret scanning and push protection enabled | Main branch is unprotected; rulesets empty; merge/rebase/squash all enabled; no release-tag protection |
| Security maintenance | Weekly dependency/action/base-image PRs; npm audit in CI | Dependabot vulnerability alerts and security updates disabled; private vulnerability reporting disabled; CodeQL default setup unconfigured |
| Versioning | Package `0.1.0-poc.1`; chart `0.1.0`, appVersion `0.1.0-poc.1`; upstream protocol pin separately `0.9.1` | No semantic-release, commitlint/semantic-title enforcement, release notes automation, tags or GitHub releases; current main history is not Conventional Commits |
| Containers | Two Dockerfiles; non-root runtime; gateway OCI source/license labels; workspace upstream image pinned by digest; pinned provider CLI versions | No publication, public artifact verification, multi-platform manifest pipeline, release/version/revision metadata, image SBOM/provenance or vulnerability scan; Node base uses a tag without digest |
| Helm packaging | Chart includes structural CRDs, RBAC, deployment, Service and NetworkPolicy | No published chart; defaults point at local `dev` images; no values schema, chart README/LICENSE/NOTES, digest-aware gateway image input, declared tested Kubernetes range or chart install/upgrade CI |
| Public installation | Local `dev:up` builds images, creates namespace and identity Secrets, applies CRDs, installs chart | Chart alone references three required Secrets it does not create; supported setup requires local source/Node/Docker build. Need documented retained-Secret bootstrap or explicit existingSecret provisioning independent of local development |
| Release evidence | Main CI green; 153 unit/SDK regressions, separate CLI contracts, extensive Docker Desktop and real Claude/private Git acceptance documented | Need acceptance against the exact published candidate digests and packaged chart, from a clean environment with no local build cache |

Evidence: `.github/workflows/ci.yaml`, `.github/dependabot.yml`,
`.github/CODEOWNERS`, `package.json`, `Dockerfile`, `docker/workspace.Dockerfile`,
`charts/paseo/`, `scripts/dev-up.sh`, `scripts/identity.ts`,
`docs/compatibility.md`, and live GitHub API reads.
The current [passing main run](https://github.com/manziman/paseo-gateway/actions/runs/35998777328)
is evidence for the current code, not for an unbuilt future release.

The package API returned HTTP 403 because the current CLI token lacks
`read:packages`. Existing GHCR package names/visibility were therefore **not
verified**. No releases or tags were returned, and no repository Actions
environments, secrets or variables were configured. Absence of a release workflow
is confirmed; package nonexistence is not assumed from a permission error.

## Recommended target

Use GitHub Container Registry for both images and the OCI chart, under the
maintainer's namespace. Docker Hub mirroring and a GitHub Pages Helm index can
wait; neither is required for a public Docker-compatible registry or OCI Helm
installation. Proposed names (not created or availability-verified):

- `ghcr.io/manziman/paseo-gateway:<version>`
- `ghcr.io/manziman/paseo-workspace:<version>`
- `oci://ghcr.io/manziman/charts/paseo-kubernetes`, chart version `<version>`

Keep one product SemVer across both images, chart version/appVersion, Git tag,
GitHub release and reported gateway runtime version. Upstream Paseo/provider
versions remain separately pinned and documented. Retain `private: true` for the
npm project: this product does not need an npm publication.

Use Conventional Commit PR titles and squash merging, with semantic-release
analyzing the resulting mainline commits. Validate titles on edits as well as
new PRs; configure squash subjects from the PR title and retain breaking-change
information. Do not require arbitrary intermediate contributor commits to be
rewritten. Define how shipped image/chart/runtime dependency changes trigger a
release; otherwise an accepted dependency update can fail to produce new images.
The [Conventional Commits specification](https://www.conventionalcommits.org/en/v1.0.0/)
explicitly supports squash-based contribution workflows.

Choose the initial release channel deliberately. Existing package/Chart versions
do not set semantic-release's first version. Stock semantic-release begins at
1.0.0; a prerelease channel can communicate experimental status, such as
1.0.0-alpha.1, without declaring stable support. A requested initial 0.1.x series
would need an explicit, tested bootstrap/version-policy decision. Preserve old
history rather than rewriting it to manufacture Conventional Commits.

The release pipeline should use the computed version to stage metadata and
package artifacts without committing generated version bumps directly to a
protected main branch. Use the standard semantic-release plugins plus a small,
reviewable Docker/Helm publishing adapter; avoid a second independent version
calculator. See [official-tool guidance](public-release-guidance.md).

## Work packages and acceptance criteria

### 1. Enforce the contribution contract

- Add a Conventional Commit PR-title check and contributing examples; align
  Dependabot commit messages with it.
- Configure main rules: PR required, stable named required checks, force-push and
  deletion blocked, and an explicit review/bypass policy appropriate to a
  single-maintainer repository. CODEOWNERS alone is not enforcement.
- Prefer squash-only merging with the PR title as commit subject. Do not require
  an independent approval that the sole maintainer cannot obtain for their own PR
  without an intentional second-reviewer/bypass arrangement.
- Protect release tags against deletion/rewriting while permitting the selected
  release automation to create them. Avoid granting general branch-protection
  bypass just to write version files.
- Enable vulnerability alerts, security updates and private reporting; add CodeQL
  and dependency review with documented blocking criteria.

Acceptance: malformed PR titles and failed required checks cannot be merged by
the normal workflow; untrusted fork PR code receives no publishing credentials.
GitHub [required-check rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
must be configured in the repository, not only described in CONTRIBUTING.md.

### 2. Make the chart independently deployable

- Replace packaged `dev` image defaults with public versioned/digest-pinned
  references; keep local-development overrides in the dev workflow.
- Provide an explicit setup path for retained gateway identity/backend/signing
  Secrets and separately supplied provider credentials. Upgrade and reinstall
  must not silently rotate identity or expose credentials in logs.
- Add values validation, chart documentation and license, installation notes,
  resource/storage/security requirements, supported version range, and useful
  metadata. Keep independent-project attribution.
- Define CRD installation/upgrade and rollback procedures, including retained
  data and the historical API-group transition. Helm does not automatically
  upgrade or delete CRDs placed in `crds/`; `helm upgrade` alone is insufficient.
  [Helm CRD guidance](https://helm.sh/docs/chart_best_practices/custom_resource_definitions/)
- Document one release per namespace if retaining the current fixed resource
  names. Multiple same-namespace installations are not an existing support claim.

Acceptance: a user can install the packaged chart with documented Secrets and
configuration without cloning this repository or building images. Fresh install,
upgrade, restart and uninstall behavior preserve the promised identities/data.

### 3. Extend CI to validate release artifacts

- Reuse existing checks; add a credential-free ephemeral Kubernetes cluster test
  for chart installation, readiness, workspace creation, retention and upgrade.
  It should use an explicitly selected test context, not depend on Docker Desktop
  being available on GitHub runners or on a user's current kubectl context.
- Build and test the declared image architectures. Current CI exercises Linux
  runner builds and local acceptance exercised macOS/arm64, but no multi-platform
  public manifest is produced. Recommend linux/amd64 and linux/arm64 only after
  verifying the upstream image and every bundled runtime on both.
- Scan the actual gateway and workspace image contents, not only npm dependencies.
  Define handling for actionable vulnerabilities versus documented exceptions.
- Render representative chart values and reject invalid values/CRDs; exercise
  the tested Kubernetes/Helm range rather than claiming arbitrary compatibility.

Acceptance: PR CI catches a broken chart/runtime before merge; candidate checks
exercise the exact artifacts that will be published, including resolved digests.

### 4. Implement semantic-release and publication

- Pin semantic-release and plugins; configure commit analysis, release notes,
  branches/channels and release eligibility. Test no-release, patch, minor,
  breaking, prerelease and bootstrap behavior before enabling publication.
- Fetch complete history/tags; serialize publishing runs and never cancel one
  halfway through publication. Publish only a trusted commit whose required
  checks passed. PR workflows remain read-only and never publish.
- Build images with source/version/revision/license metadata; publish immutable
  version references and record digests. Produce image SBOMs and provenance,
  chart checksums/attestations and a release artifact manifest.
- Package the chart only after image references are resolved. Include packaged
  chart, CRDs, checksums, compatibility/upgrade notes and artifact digests in the
  GitHub release.
- Use job-scoped permissions and the GitHub workflow token where supported;
  artifact attestation uses narrowly scoped OIDC permission. Avoid a long-lived
  personal token by default. Verify first-publish package visibility separately.
- Keep publication steps in the same trusted pipeline rather than assuming a
  release created with `GITHUB_TOKEN` will trigger another release workflow.
- Define recovery from partial publication. Versioned image and chart publication
  is not a cross-registry transaction: reruns must not silently overwrite a
  published version with different contents, and a missing artifact must be
  recoverable without falsely declaring the release complete.

Acceptance: a release-worthy squash commit produces one coherent version,
changelog/release notes, two public images and one public OCI chart with matching
metadata, verifiable provenance and documented rerun behavior. A docs-only change
does not accidentally publish. No token is required to pull public artifacts.

### 5. Qualify and publish the first release

- Confirm bundled library/runtime redistribution terms and required notices.
  Existing NOTICE acknowledges Claude Code but is not a completed dependency
  license inventory. Anthropic documents conditions for preinstalling its
  unmodified binary; verify the chosen distribution/authentication flow against
  those conditions rather than treating the whole image as Apache-2.0.
  [Vendor guidance](https://code.claude.com/docs/en/legal-and-compliance)
- State the first release's exact support envelope: experimental headless
  deployment, validated Docker Desktop/storage configuration, supported provider
  credentials, and explicit limitations. EKS, complete desktop parity, shared
  Codex OAuth renewal and Agent Sandbox adoption are not established by current
  evidence. Resolve #22/#26 before claiming the broader existing parity bar.
- Verify anonymous pull of **each** image and OCI chart, then install those exact
  published artifacts in a clean namespace/environment without local image tags.
- Run the relevant real-provider acceptance against the candidate and record
  exact digests. Keep private-repository credentials/provider tests separate from
  untrusted PR jobs; existing authorized fixtures need not become public data.
- Update the README with public install/upgrade instructions, release badges,
  compatibility matrix, support policy and links to release artifacts. Reconcile
  issue checklists with recorded evidence rather than treating all open issues as
  unimplemented or closing parity gaps because publication works.

Acceptance: a new user can anonymously pull/install a named version, establish
their own credentials, run the supported workflow, and identify the exact code
and runtime versions. This is the definition of the first deployable public
release; stable/full-parity claims require their additional acceptance gates.

## Later improvements, not first-release requirements

Artifact Hub listing, Docker Hub mirroring, GitHub Pages chart index, coverage
badges/strict coverage ratchets, OpenSSF scorecards, automated dependency merging,
additional Kubernetes distributions, HA, and Agent Sandbox adoption can follow.
They should not distract from protected PRs, correct versioning, safe publication,
anonymous installation and honest compatibility claims.
