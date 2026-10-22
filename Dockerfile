# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
RUN npm install -g pnpm@12.14.0
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --offline
# The desktop shell is built by its own release workflow.
ARG VITE_RELEASES_URL
RUN pnpm -r --filter '!@harmony/desktop' build
RUN pnpm deploy --prod --filter @harmony/server /deploy

FROM node:24-alpine
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/apps/web/dist \
    UPLOAD_DIR=/data/uploads
WORKDIR /app
# A new named volume copies this directory's ownership, so the node user can write to it.
RUN mkdir -p /data/uploads && chown node:node /data/uploads
COPY --from=build --chown=node:node /deploy apps/server
COPY --from=build --chown=node:node /repo/apps/web/dist apps/web/dist
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/server.js"]
