# Redistribution inventory and release check

The Dockerfiles are the build recipe, while the image manifest and SBOM show
what a release actually ships. Repeat this procedure for the exact gateway and
workspace digests to be published, for every supported architecture. Record
the output alongside release checksums and provenance. A changed base image,
Paseo pin, provider CLI, Debian package, or transitive npm tree reopens this
review. The chart packages this project's templates, CRDs, README/LICENSE and
notices; it does not embed container files.

## Preliminary local inspection, 2026-09-24

These existing local `linux/arm64` candidates were inspected before the public
release pipeline produced final artifacts. Their IDs are local image IDs, **not
published registry digests**:

| Image | Local image ID | Observed inventory |
| --- | --- | --- |
| `paseo-gateway:mvp-20260924` | `sha256:372781ceab75bbca2ca52fdfcb1808703f1162483702cc42b89e471bfba8c212` | Node 24.12.0; six direct production npm dependencies including Paseo client/protocol 0.9.1; 88 Debian packages; project LICENSE and NOTICE present. |
| `paseo-workspace:mvp-20260924` | `sha256:0d075cda58b81449acca966a5eac16b0229eb6a551ca37e0d67a42558f3e1d9b` | Node 22.23.2; Paseo daemon and CLI packages 0.9.1; Claude Code 2.1.274, Codex 0.156.1, OpenCode 1.18.32; 128 Debian packages. No top-level gateway LICENSE/NOTICE in this pre-release image. |

The package counts are `dpkg-query -W` counts. They do not replace a full SBOM
or license review. The inventory script found 75 package manifests with names
and versions in gateway `/app/node_modules`, and 502 in workspace global npm
modules, including nested and optional packages. Upstream Paseo's published
packages omit `license` metadata, so their pinned source license must be checked
separately. The workspace image retained the OpenCode MIT license,
Anthropic's license pointer, Node's license, and Debian copyright files. The
Codex npm wrapper declares Apache-2.0 but contains no top-level LICENSE file;
the project Apache-2.0 text and this notice should accompany the final image.

## Exact candidate procedure

Set `GATEWAY_IMAGE` and `WORKSPACE_IMAGE` to immutable `@sha256:` references
from the publishing run. For each platform, pull by digest and inspect that
platform's image. Save the raw outputs as release evidence:

```sh
docker image inspect "$GATEWAY_IMAGE" > gateway-image-inspect.json
docker image inspect "$WORKSPACE_IMAGE" > workspace-image-inspect.json

docker run --rm --entrypoint sh "$GATEWAY_IMAGE" -ec 'node --version; dpkg-query -W' > gateway-inventory.txt
docker run --rm --entrypoint sh "$WORKSPACE_IMAGE" -ec 'node --version; dpkg-query -W' > workspace-inventory.txt

docker run --rm -v "$PWD:/audit:ro" --entrypoint node "$GATEWAY_IMAGE" /audit/scripts/inventory-npm-licenses.mjs /app/node_modules > gateway-npm-licenses.json
docker run --rm -v "$PWD:/audit:ro" --entrypoint node "$WORKSPACE_IMAGE" /audit/scripts/inventory-npm-licenses.mjs /usr/local/lib/node_modules > workspace-npm-licenses.json

docker run --rm --entrypoint dpkg-query "$GATEWAY_IMAGE" -W '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' > gateway-debian-sources.tsv
docker run --rm --entrypoint dpkg-query "$WORKSPACE_IMAGE" -W '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' > workspace-debian-sources.tsv

docker run --rm --entrypoint sh "$GATEWAY_IMAGE" -c 'test -s /app/LICENSE && test -s /app/NOTICE && test -s /app/THIRD_PARTY_NOTICES.md'
docker run --rm --entrypoint sh "$WORKSPACE_IMAGE" -c 'test -s /usr/share/doc/paseo-gateway/LICENSE && test -s /usr/share/doc/paseo-gateway/NOTICE && test -s /usr/share/doc/paseo-gateway/THIRD_PARTY_NOTICES.md'
```

The release pipeline's SPDX SBOMs provide the full package inventory. Compare
them with the package-manifest and `dpkg-query` outputs and the source/license links in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Inspect any `NOASSERTION`,
missing-license, or unexpected copyleft/proprietary entry instead of assuming
an npm registry entry proves redistribution permission. Keep package and OS
license files in the images and attach the notice to the chart/GitHub release.

Before checksum generation and upload, bundle the exact Debian source files for
every image and architecture inventory:

```sh
python3 scripts/bundle-debian-sources.py "$RELEASE_OUTPUT" "$RELEASE_OUTPUT"/*-debian-sources.tsv
```

This writes `debian-corresponding-source.tar.gz` and
`debian-source-manifest.json` into the release output directory. The script
fetches each `.dsc` and associated source archive from Debian Snapshot,
checks the downloaded size and SHA-1, and verifies SHA-256 values against the
`.dsc` before producing the release asset. Download cache files stay outside
the upload directory. Attach both files and include them in `SHA256SUMS`.

The maintainer confirmed on 2026-09-24 that Claude Code will remain bundled
after reviewing the [Anthropic product preinstallation conditions](https://code.claude.com/docs/en/legal-and-compliance).
The exact candidate check must verify the CLI is unmodified, retains built-in
authentication methods, and uses operator-owned credentials without resale or
intermediation. For Debian packages, verify exact source versions in the source
manifest remain obtainable from the Debian archives; preserve and provide any
missing corresponding source before publishing. No secret is included in the
artifact inventory.
