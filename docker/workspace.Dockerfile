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

FROM ghcr.io/getpaseo/paseo:0.9.1@sha256:9aae08258b6ff85853da3144ef48c2fd355cfe644500ca4d6041753da589098d
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
# Replace only upstream Paseo's 0.25.12 platform executable. Other esbuild
# installations in user workspaces keep their own version-matched binaries.
COPY --from=esbuild /esbuild /tmp/patched-esbuild
RUN case "$TARGETARCH" in amd64|arm64) ;; *) exit 1 ;; esac \
    && binary="/usr/local/lib/node_modules/@getpaseo/server/node_modules/@esbuild/linux-$TARGETARCH/bin/esbuild" \
    && test -f "$binary" \
    && install -m 755 /tmp/patched-esbuild "$binary" \
    && rm /tmp/patched-esbuild \
    && "$binary" --version | grep -Fx '0.25.12'
COPY docker/initialize.mjs /opt/paseo/initialize.mjs
COPY docker/git-credential.mjs /opt/paseo/git-credential.mjs
COPY docker/teardown.mjs /opt/paseo/teardown.mjs
COPY docker/token-file.mjs /opt/paseo/token-file.mjs
COPY --chmod=755 docker/gh.mjs /usr/local/bin/gh
COPY --chmod=755 docker/paseo-cli.mjs /opt/paseo/bin/paseo
COPY docker/cli-target.mjs /opt/paseo/bin/cli-target.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/paseo-workspace-entrypoint
ENTRYPOINT ["/usr/local/bin/paseo-workspace-entrypoint"]
USER 1000:1000
ENV PASEO_WEB_UI_ENABLED=false \
    PASEO_DICTATION_ENABLED=false \
    PASEO_VOICE_MODE_ENABLED=false
