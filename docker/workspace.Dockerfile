FROM ghcr.io/getpaseo/paseo:0.8.0@sha256:5518da7cdd35f132e8a944c35e509c677a90a8f3ec8a78df98f7fb5fd5e2c6c3
USER root
RUN npm install --global @anthropic-ai/claude-code@2.1.274 && npm cache clean --force
COPY docker/initialize.mjs /opt/paseo/initialize.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/paseo-workspace-entrypoint
ENTRYPOINT ["/usr/local/bin/paseo-workspace-entrypoint"]
USER 1000:1000
ENV PASEO_WEB_UI_ENABLED=false \
    PASEO_DICTATION_ENABLED=false \
    PASEO_VOICE_MODE_ENABLED=false
