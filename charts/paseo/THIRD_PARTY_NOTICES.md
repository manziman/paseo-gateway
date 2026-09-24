# Third-party runtime notices

Paseo Gateway is an independent Apache-2.0 project. Its license covers this
project's code, not every component in its images. The exact versions and
transitive packages in a published image are identified by that image's SBOM;
the entries below identify the prominent bundled runtimes and terms that need
manual review. See [the inventory procedure](docs/redistribution.md).

| Component in image | Version in current build definition | License or terms and attribution |
| --- | --- | --- |
| Upstream Paseo daemon and `@getpaseo/*` packages (workspace); client/protocol packages (gateway) | 0.9.1 | Apache-2.0; copyright Mohamed Boudra and Paseo contributors. [Pinned source license](https://github.com/getpaseo/paseo/blob/v0.9.1/LICENSE). Independent project; no upstream endorsement. |
| Claude Code CLI, official unmodified npm package (workspace) | 2.1.274 | Anthropic proprietary terms; [license and product preinstallation conditions](https://code.claude.com/docs/en/legal-and-compliance). Its package includes `LICENSE.md` pointing to those terms. Claude Code is not under the gateway's Apache-2.0 license. |
| Codex CLI, official npm package (workspace) | 0.156.1 | Apache-2.0 in its package metadata and [versioned source license](https://github.com/openai/codex/blob/rust-v0.156.1/LICENSE). OpenAI's [self-hosted environment guidance](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted) shows installing the CLI in a container; each operator supplies their own credentials. Codex is not endorsed by or affiliated with this project. |
| OpenCode CLI, official npm package (workspace) | 1.18.32 | MIT in package metadata; its full license text is included at `/usr/local/lib/node_modules/opencode-ai/LICENSE` in the inspected image. OpenCode is not endorsed by or affiliated with this project. |
| Node.js (both images); npm 12.1.0, Corepack and Yarn (workspace) | Image-specific | Retain their license files within their installed paths, including `/usr/local/LICENSE`, `/usr/local/lib/node_modules/npm/LICENSE`, and `/opt/yarn-v1.22.22/LICENSE` where present. The gateway runtime omits npm. |
| esbuild (workspace, Paseo plugin runtime) | 0.25.12 | MIT. Its upstream 0.25.12 source is [available here](https://github.com/evanw/esbuild/tree/v0.25.12); this image replaces only the bundled Paseo platform executable with the same source rebuilt using Go 1.27.1 to address Go runtime vulnerabilities. The JavaScript API remains 0.25.12. |
| linkify-it and uc.micro (workspace, Paseo Markdown rendering) | 5.0.2 and 2.1.0 | MIT; [linkify-it source](https://github.com/markdown-it/linkify-it/tree/5.0.2) and [uc.micro source](https://github.com/markdown-it/uc.micro/tree/2.1.0). The image updates Paseo's vulnerable transitive linkify-it 2.2.0 and nests uc.micro 2.1.0 for it; Markdown-it keeps its own uc.micro 1.x. |
| Debian packages, including `gh` and OpenSSH in the workspace | Image-specific | Each package retains its own copyright/license declaration under `/usr/share/doc/<package>/copyright`, as [Debian policy](https://www.debian.org/doc/debian-policy/ch-docs.html#copyright-information) requires. Some packages use GPL/LGPL terms; see the corresponding-source instructions below. |
| `argparse` npm dependency (gateway) | 2.0.1 | Python-2.0 declared in its package metadata; full license and copyright text is retained at `/app/node_modules/argparse/LICENSE`. |
| `spdx-exceptions` npm dependency (workspace, through npm) | 2.5.0 | CC-BY-3.0 declared in package metadata. The data derives from the SPDX specification: © 2010–2015 Linux Foundation and its Contributors, [source attribution](https://github.com/jslicense/spdx-exceptions.json#copyright-and-licensing), [license](https://creativecommons.org/licenses/by/3.0/legalcode.en). No changes were made to this data by Paseo Gateway. |

The Apache-2.0 text in this repository's [LICENSE](LICENSE) is also the license
text for the pinned upstream Paseo and Codex CLI releases. The MIT text for
OpenCode and Anthropic's license pointer remain in their installed package
directories. Published image metadata, SPDX SBOMs, and Debian/npm package
inventories should be consulted for transitive components and exact versions.

## Claude Code distribution and authentication

[Anthropic's published guidance](https://code.claude.com/docs/en/legal-and-compliance)
says product preinstallation or operation of Claude Code requires agreement to
its Commercial Terms unless separately agreed otherwise. It also requires the
unmodified binary with built-in authentication methods intact, and direct
end-user authentication and billing. This project must not resell or
intermediate Claude usage. Operators provide their own credentials under their
own vendor agreements; provider tokens must never be baked into an image or
release artifact. The current documented setup-token path is operator-managed
for a single trusted owner. It does not establish general multi-user Claude
subscription support or a right to intermediate another user's account.

On 2026-09-24, the maintainer confirmed proceeding with Claude Code bundled
after review of Anthropic's published product preinstallation conditions.
The release still needs a final check that the packaged CLI remains unmodified,
all its built-in authentication methods work, and operator-owned credentials
are used without resale or intermediation. This notice records the vendor
condition and maintainer decision; it is not a legal opinion.

## Debian corresponding source

[Debian's guidance for binary redistributors](https://www.debian.org/CD/vendors/legal)
explains that distributing GPL-licensed binary packages requires providing
corresponding source. Each GitHub release carries
`debian-corresponding-source.tar.gz` alongside the image digest, SPDX SBOMs,
and architecture-specific Debian package inventories. That archive contains
the exact Debian source control files (`.dsc`) and all source archives for the
source package versions installed in the release images. Its
`debian-source-manifest.json` records the file names, sizes, and SHA-1/SHA-256
checksums; the build verifies the checksums declared by each `.dsc` before
publishing. Files originate from the
[Debian snapshot archive](https://snapshot.debian.org/). Installed copyright
files remain under `/usr/share/doc/<package>/copyright` in the images. The
source archive is distinct from the npm SBOM and this project's source tree.
