# Contributing

Open an issue for behavior changes that affect the protocol, credentials,
storage, or project scope. Small fixes can arrive directly as pull requests.

Use a [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/)
subject for the PR title. The title becomes the squash commit subject, so each
PR needs one release intent. Examples:

- `feat: add workspace retention` (new user-facing behavior; minor release)
- `fix(chart): preserve identity Secret on upgrade` (shipped fix; patch release)
- `fix(deps): update workspace runtime` (shipped dependency or image fix; patch release)
- `docs: clarify installation prerequisites` (documentation only; no release)
- `feat!: remove the legacy protocol` (breaking release)

The accepted types are `feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `build`,
`ci`, `chore`, `style`, and `revert`; a lowercase scope and `!` are optional.
Use `!` in the title and explain the migration in the PR body for a breaking
change. Classify changes that alter the shipped chart, images, or runtime
dependencies as `fix` or `feat` when they should produce new artifacts. Keep
intermediate commits freely organized; the PR title is the release boundary.

Use Node 24 and `npm ci`. Before submitting, run `npm run check`,
`npm run generate:crds`, and `helm lint charts/paseo`. Run `npm run test:upstream`
for protocol changes and the relevant [live tests](docs/testing.md) for lifecycle
changes. Include evidence and explicitly identify checks you could not run.

Keep controller desired-state decisions separate from gateway session behavior.
CI requires the `upstream` AMD64 and `upstream-arm64` native ARM64 daemon checks.
Release artifacts repeat both architecture checks against immutable digests.

Use exported upstream package interfaces and exact dependency versions. Do not
vendor Paseo implementation files or bypass TypeScript errors with `any`.
Document public module boundaries and non-obvious invariants. Tests should cover
observable behavior, particularly interruption and recovery, rather than mirror
implementation details. Never put credentials or prompt contents in fixtures,
logs, screenshots, CRDs, or issue reports.

Changes are contributed under Apache-2.0. Confirm you have the right to submit
them. There is no CLA. Follow the [code of conduct](CODE_OF_CONDUCT.md).

Maintainers should require passing CI and review before merging, enable
dependency/security alerts and private vulnerability reporting, and protect
release tags. These GitHub repository settings are not configured by files in
this checkout. Releases must satisfy [the acceptance checklist](docs/compatibility.md)
and record image digests, dependency licenses/notices, SBOMs, checksums and
provenance before publication. This repository does not automatically publish
images or release artifacts from pull requests.
