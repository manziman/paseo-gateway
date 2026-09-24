FROM ghcr.io/getpaseo/paseo:0.9.2@sha256:d413ff361bc4018d559da3d517a6d5a9eaca721fbb1b71ae8df3dcf7a965c136
USER root
RUN apt-get update && apt-get install -y --no-install-recommends gh openssh-client \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @anthropic-ai/claude-code@2.1.274 @openai/codex@0.156.1 opencode-ai@1.18.32 \
    && npm cache clean --force
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
