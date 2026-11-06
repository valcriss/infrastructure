# syntax=docker/dockerfile:1
# Images de la console et de l'agent. Cibles : `console`, `agent`.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/console/package.json packages/console/
COPY packages/agent/package.json packages/agent/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY packages packages
RUN npm run build

# --- Console --------------------------------------------------------------
FROM node:24-alpine AS console
WORKDIR /app
ENV NODE_ENV=production \
    WEB_DIR=/app/packages/web/dist \
    SHARED_DIR=/shared \
    DATA_DIR=/data
# git : sauvegarde de la configuration dans un dépôt Git (HTTPS + jeton).
RUN apk add --no-cache git ca-certificates
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/console/package.json packages/console/
COPY packages/agent/package.json packages/agent/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev -w @infra/console && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/console/dist packages/console/dist
COPY packages/console/migrations packages/console/migrations
COPY --from=build /app/packages/web/dist packages/web/dist
# Le volume nommé hérite de ce propriétaire à sa première création.
RUN mkdir -p /shared /data && chown node:node /shared /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/console/dist/main.js"]

# --- Agent ------------------------------------------------------------------
# Exécuté en root : l'accès au socket Docker équivaut de toute façon à un accès
# root à l'hôte (voir la section sécurité de la documentation).
FROM node:24-alpine AS agent
WORKDIR /app
ENV NODE_ENV=production \
    STATE_DIR=/data
# CLI Docker et plugin Compose : l'agent pilote `docker compose` par arguments structurés.
RUN apk add --no-cache docker-cli docker-cli-compose
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/console/package.json packages/console/
COPY packages/agent/package.json packages/agent/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev -w @infra/agent && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/agent/dist packages/agent/dist
RUN mkdir -p /data
CMD ["node", "packages/agent/dist/main.js"]
