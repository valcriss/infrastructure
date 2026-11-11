# syntax=docker/dockerfile:1
# Images de la console et de l'agent. Cibles : `console`, `agent`.

# Compilation sur la plateforme du runner (TypeScript et Vite produisent du JavaScript indépendant
# de l'architecture) : évite de la faire sous émulation lors d'un build arm64.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
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
# Paquets système à jour (correctifs de sécurité publiés depuis la construction de l'image de base).
RUN apk upgrade --no-cache && apk add --no-cache git ca-certificates
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/console/package.json packages/console/
COPY packages/agent/package.json packages/agent/
COPY packages/web/package.json packages/web/
# npm, npx, corepack et yarn sont retirés après l'installation : inutiles à l'exécution, ils embarquent leurs
# propres dépendances (surface d'attaque et CVE) et le noyau de l'image reste Node seul.
RUN npm ci --omit=dev -w @infra/console && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm
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
RUN apk upgrade --no-cache && apk add --no-cache docker-cli docker-cli-compose
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/console/package.json packages/console/
COPY packages/agent/package.json packages/agent/
COPY packages/web/package.json packages/web/
# npm, npx, corepack et yarn sont retirés après l'installation : inutiles à l'exécution, ils embarquent leurs
# propres dépendances (surface d'attaque et CVE) et le noyau de l'image reste Node seul.
RUN npm ci --omit=dev -w @infra/agent && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/agent/dist packages/agent/dist
RUN mkdir -p /data
CMD ["node", "packages/agent/dist/main.js"]

# --- Patcher ----------------------------------------------------------------
# Moteur de correctifs de la remédiation des images : Project Copacetic seul. Il pilote un BuildKit distinct (image
# officielle, lancée à part par l'agent) et n'a pas besoin du socket Docker. Version et sommes SHA-256 épinglées :
# l'archive est vérifiée avant d'être installée.
FROM alpine:3.22 AS patcher
ARG TARGETARCH
ARG COPA_VERSION=0.15.0
ARG COPA_SHA256_AMD64=cff3fe9320f3bd24bafcfd0ce877ef57e23acad0836da0ac6c253919f71c9cad
ARG COPA_SHA256_ARM64=2444b6109c6164beef980641ec5f2813bc42b1703add6dd73591ace23051ca8f
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates curl \
    && case "${TARGETARCH:-amd64}" in \
         amd64) sha="$COPA_SHA256_AMD64" ;; \
         arm64) sha="$COPA_SHA256_ARM64" ;; \
         *) echo "architecture non prise en charge : ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /tmp/copa.tar.gz "https://github.com/project-copacetic/copacetic/releases/download/v${COPA_VERSION}/copa_${COPA_VERSION}_linux_${TARGETARCH:-amd64}.tar.gz" \
    && echo "${sha}  /tmp/copa.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/copa.tar.gz -C /usr/local/bin copa \
    && rm -f /tmp/copa.tar.gz \
    && apk del curl
ENTRYPOINT ["/usr/local/bin/copa"]
