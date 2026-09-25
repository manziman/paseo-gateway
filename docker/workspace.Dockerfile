# Paseo 0.9.1 uses esbuild 0.25.12 at runtime for plugin compilation. Rebuild
# that exact esbuild source with a patched Go toolchain; the prebuilt binary
# bundled in the upstream image uses Go 1.23.12.
FROM --platform=$BUILDPLATFORM golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195 AS esbuild
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
ADD --checksum=sha256:eca56e4242e68ebde6f327458c71457e614a2b0564b30a45d60fc633e0ccaab4 https://github.com/evanw/esbuild/archive/refs/tags/v0.25.12.tar.gz /tmp/esbuild.tar.gz
RUN tar -xzf /tmp/esbuild.tar.gz --strip-components=1 \
    && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath -buildvcs=false -ldflags="-s -w" -o /esbuild ./cmd/esbuild \
    && go version -m /esbuild | grep -F 'go1.27.1'
# Paseo's markdown-it 10 pulls linkify-it 2.2.0. Linkify-it 5 keeps the
# callable API but needs uc.micro 2; nest it so markdown-it keeps uc.micro 1.
ADD --checksum=sha256:f5169c5e5d837b5229180cb7214102d42f5c963f6932f284b608ef9549e927b4 https://registry.npmjs.org/linkify-it/-/linkify-it-5.0.2.tgz /tmp/linkify-it.tgz
ADD --checksum=sha256:a31660c690ddac370fe4b17fe6a3a73b8df094f99194ac90d0668d797dabf69b https://registry.npmjs.org/uc.micro/-/uc.micro-2.1.0.tgz /tmp/uc.micro.tgz
RUN mkdir -p /patched-linkify /patched-uc-micro \
    && tar -xzf /tmp/linkify-it.tgz -C /patched-linkify --strip-components=1 \
    && tar -xzf /tmp/uc.micro.tgz -C /patched-uc-micro --strip-components=1

FROM ghcr.io/getpaseo/paseo:0.9.2@sha256:d413ff361bc4018d559da3d517a6d5a9eaca721fbb1b71ae8df3dcf7a965c136
ARG TARGETARCH
ARG RELEASE_VERSION=0.1.0-poc.1
ARG RELEASE_REVISION=development
LABEL org.opencontainers.image.source="https://github.com/manziman/paseo-gateway" \
      org.opencontainers.image.version="$RELEASE_VERSION" \
      org.opencontainers.image.revision="$RELEASE_REVISION" \
      org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-Bundled-Third-Party"
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/doc/paseo-gateway/
USER root
RUN apt-get update && apt-get install -y --no-install-recommends gh openssh-client \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @anthropic-ai/claude-code@2.1.274 @openai/codex@0.156.1 opencode-ai@1.18.32 \
    && npm cache clean --force
RUN npm install --global npm@12.1.0 --ignore-scripts \
    && npm cache clean --force \
    && npm --version | grep -Fx '12.1.0'
# Replace only upstream Paseo's 0.25.12 platform executable. Other esbuild
# installations in user workspaces keep their own version-matched binaries.
COPY --from=esbuild /esbuild /tmp/patched-esbuild
RUN case "$TARGETARCH" in amd64) esbuild_arch=x64 ;; arm64) esbuild_arch=arm64 ;; *) exit 1 ;; esac \
    && binary="/usr/local/lib/node_modules/@getpaseo/server/node_modules/@esbuild/linux-$esbuild_arch/bin/esbuild" \
    && test -f "$binary" \
    && install -m 755 /tmp/patched-esbuild "$binary" \
    && rm /tmp/patched-esbuild \
    && "$binary" --version | grep -Fx '0.25.12'
RUN rm -rf /usr/local/lib/node_modules/@getpaseo/server/node_modules/linkify-it
COPY --from=esbuild /patched-linkify/ /usr/local/lib/node_modules/@getpaseo/server/node_modules/linkify-it/
COPY --from=esbuild /patched-uc-micro/ /usr/local/lib/node_modules/@getpaseo/server/node_modules/linkify-it/node_modules/uc.micro/
COPY docker/initialize.mjs /opt/paseo/initialize.mjs
COPY docker/checkout-failure.mjs /opt/paseo/checkout-failure.mjs
COPY docker/checkout-budget.mjs /opt/paseo/checkout-budget.mjs
COPY docker/inspect-refs.mjs /opt/paseo/inspect-refs.mjs
COPY docker/git-credential.mjs /opt/paseo/git-credential.mjs
COPY docker/teardown.mjs /opt/paseo/teardown.mjs
COPY docker/tls-proxy.mjs /opt/paseo/tls-proxy.mjs
COPY docker/token-file.mjs /opt/paseo/token-file.mjs
# Remove the npm bin symlink before COPY, preserving the unmodified native launcher.
RUN rm /usr/local/bin/codex
COPY --chmod=755 docker/codex.mjs /usr/local/bin/codex
COPY --chmod=755 docker/gh.mjs /usr/local/bin/gh
COPY --chmod=755 docker/paseo-cli.mjs /opt/paseo/bin/paseo
COPY docker/cli-target.mjs /opt/paseo/bin/cli-target.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/paseo-workspace-entrypoint
ENTRYPOINT ["/usr/local/bin/paseo-workspace-entrypoint"]
USER 1000:1000
ENV PASEO_WEB_UI_ENABLED=false \
    PASEO_DICTATION_ENABLED=false \
    PASEO_VOICE_MODE_ENABLED=false
