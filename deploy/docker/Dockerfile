# syntax=docker/dockerfile:1.7
#
# One file, one target per image:
#   docker build --target gateway       -t omnisync-gateway       -f deploy/docker/Dockerfile .
#   docker build --target control-plane -t omnisync-control-plane -f deploy/docker/Dockerfile .
#   docker build --target web           -t omnisync-web           -f deploy/docker/Dockerfile .
#
# The release pipeline passes BASE_IMAGE and NGINX_IMAGE pinned by digest (docs/specs/release.md).
ARG BASE_IMAGE=node:22.22.2-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28-alpine

# ---- build: install, compile everything once ---------------------------------------------------------------
# hadolint ignore=DL3006
FROM ${BASE_IMAGE} AS build
ENV CI=true
RUN corepack enable
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile \
 && pnpm build

# ---- deploy: a self-contained, production-only directory per service ----------------------------------------
FROM build AS deploy-gateway
RUN pnpm --filter @omnisync/gateway --prod deploy --legacy /out \
 && rm -rf /out/src /out/test /out/tsconfig*.json

FROM build AS deploy-control-plane
RUN pnpm --filter @omnisync/control-plane --prod deploy --legacy /out \
 && rm -rf /out/src /out/test /out/tsconfig*.json /out/vitest.config.ts

# ---- runtimes ------------------------------------------------------------------------------------------------
# hadolint ignore=DL3006
FROM ${BASE_IMAGE} AS runtime-base
ENV NODE_ENV=production
RUN groupadd --gid 10001 omnisync && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin omnisync
WORKDIR /app
USER 10001:10001

FROM runtime-base AS gateway
COPY --from=deploy-gateway --chown=root:root /out /app
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/serve.js"]

FROM runtime-base AS control-plane
COPY --from=deploy-control-plane --chown=root:root /out /app
EXPOSE 8081
ENV PORT=8081
CMD ["node", "dist/main.js"]

# ---- web: both Angular apps, behind an unprivileged nginx. The chart supplies nginx's configuration and each
# app's config.json, so the image holds no environment-specific file. --------------------------------------
# hadolint ignore=DL3006
FROM ${NGINX_IMAGE} AS web
COPY --from=build --chown=root:root /src/apps/console/dist /usr/share/nginx/html/console
COPY --from=build --chown=root:root /src/apps/reference-app/dist /usr/share/nginx/html/app
EXPOSE 8080
