FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
ARG RELEASE_VERSION=0.1.0-poc.1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev \
    && npm pkg set version="$RELEASE_VERSION"

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG RELEASE_VERSION=0.1.0-poc.1
ARG RELEASE_REVISION=development
LABEL org.opencontainers.image.source="https://github.com/manziman/paseo-gateway" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="$RELEASE_VERSION" \
      org.opencontainers.image.revision="$RELEASE_REVISION"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.156.1 --ignore-scripts \
    && npm cache clean --force
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
USER 1000:1000
EXPOSE 8080
# The pinned SDK AOT validator reproduced a Maglev native-memory spike on
# linux/arm64 Node 24.21.0; other architectures require separate qualification.
# Keep this explicit: --no-maglev is not accepted in NODE_OPTIONS.
CMD ["node", "--no-maglev", "dist/main.js"]
