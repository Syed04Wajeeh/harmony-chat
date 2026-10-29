# syntax=docker/dockerfile:1
# Build context is this directory: docker build -t harmony-homelab-bot examples/homelab-bot
FROM node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a AS deps
WORKDIR /app
COPY package.json ./
# The workspace-only packages are development dependencies (types and tests); install the rest.
RUN npm pkg delete devDependencies scripts \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Run as the image's unprivileged user; nothing is written, so the config can be mounted read-only.
USER node
CMD ["node", "src/main.ts"]
