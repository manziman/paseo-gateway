FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.12.0-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/manziman/paseo-gateway" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY package.json LICENSE NOTICE ./
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/main.js"]
