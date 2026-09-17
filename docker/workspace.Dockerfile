FROM ghcr.io/getpaseo/paseo:0.7.1@sha256:622ae1ec9d13b45073bcc0a72b286fc50ca8c6a5c5f3a31b468e67d3fcb11dac
USER root
RUN npm install --global @anthropic-ai/claude-code@2.1.274 && npm cache clean --force
COPY docker/initialize.mjs /opt/paseo/initialize.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/paseo-workspace-entrypoint
ENTRYPOINT ["/usr/local/bin/paseo-workspace-entrypoint"]
USER 1000:1000
ENV PASEO_WEB_UI_ENABLED=false \
    PASEO_DICTATION_ENABLED=false \
    PASEO_VOICE_MODE_ENABLED=false
