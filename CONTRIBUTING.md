# Contributing

Open an issue for behavior changes that affect the protocol, credentials,
storage, or project scope. Small fixes can arrive directly as pull requests.

Use Node 24 and `npm ci`. Before submitting, run `npm run check`,
`npm run generate:crds`, and `helm lint charts/paseo`. Run `npm run test:upstream`
for protocol changes and the relevant [live tests](docs/testing.md) for lifecycle
changes. Include evidence and explicitly identify checks you could not run.

Keep controller desired-state decisions separate from gateway session behavior.
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
