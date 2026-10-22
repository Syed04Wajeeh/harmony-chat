# Harmony

A self-hosted, Discord-style team chat app: servers (guilds) with public and private channels, DMs, message history with keyset pagination, replies, reactions, mentions, pins, search, file uploads, unread counts and presence, delivered live over WebSockets and Redis pub/sub. Identity comes from Tailscale Serve, so there are no passwords or sign-up. The REST and WebSocket contract is in [docs/api/protocol.md](docs/api/protocol.md).

## Quickstart (Docker)

```sh
cp .env.example .env        # set POSTGRES_PASSWORD, PROXY_SHARED_SECRET, PUBLIC_ORIGIN
docker compose up -d --build
curl http://127.0.0.1:8470/healthz
```

Request path: Tailscale Serve (HTTPS) → `127.0.0.1:8470` → nginx → app. nginx is the only published port and stamps a shared secret on every request; the app rejects requests without it. Postgres and Redis stay on the internal network, and a one-shot `migrate` service applies migrations before the app starts. Uploads live in the `harmony_uploads` volume (limit `UPLOAD_MAX_BYTES`, default 10 MiB).

Point Serve at nginx and set `PUBLIC_ORIGIN` to the exact URL browsers use, for example:

```sh
tailscale serve --bg --https=18470 http://127.0.0.1:8470
# PUBLIC_ORIGIN=https://chat.example.ts.net:18470
```

Bots and integrations (bot tokens, incoming webhooks, slash commands, signed outgoing events) are described in [docs/api/protocol.md](docs/api/protocol.md) and [docs/security/trust-model.md](docs/security/trust-model.md); `examples/` has a bot, an Uptime Kuma recipe and a curl script. Events are delivered by a separate `worker` service, and `127.0.0.1:8471` is a host-local ingress that only forwards bot-token requests, webhooks and interaction follow-ups. Bots owned by an instance admin can reach private hosts listed in `OUTBOUND_PRIVATE_ALLOWLIST`; everyone else's can only reach public addresses.

Set `ALLOWED_LOGINS` (comma-separated) to restrict access to specific tailnet users; empty allows any user on the tailnet.

To exercise the API without Serve, send the headers it would add:

```sh
curl -H 'Tailscale-User-Login: you@example.com' http://127.0.0.1:8470/api/me
```

## Development

Requires Node 24, pnpm 12 (`corepack enable pnpm`) and Docker for Postgres and Redis.

```sh
pnpm install
docker run -d --name harmony-dev-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=harmony -p 5432:5432 postgres:16-alpine
docker run -d --name harmony-dev-redis -p 6379:6379 redis:7-alpine

export DATABASE_URL=postgres://postgres:dev@localhost:5432/harmony
export REDIS_URL=redis://localhost:6379
export DEV_AUTH_LOGIN=you@example.com   # fake identity; only honored when NODE_ENV=development
export DEV_AUTH_NAME=You                # optional

pnpm --filter @harmony/server migrate
pnpm dev                    # server on :8080, Vite on :5173 (proxies /api including WebSockets)
```

Open http://localhost:5173. The Origin check applies in development too, and defaults to `http://localhost:5173`; set `PUBLIC_ORIGIN` if you use another host. The server refuses to start with `DEV_AUTH_LOGIN` set outside development.

| Command                 | What it does                                   |
| ----------------------- | ---------------------------------------------- |
| `pnpm lint`             | ESLint (typescript-eslint, type-checked rules) |
| `pnpm typecheck`        | `tsc` across all workspaces                    |
| `pnpm test:unit`        | Vitest unit tests                              |
| `pnpm test:integration` | Vitest + Testcontainers (needs Docker)         |
| `pnpm build`            | Build shared, server and web                   |
| `pnpm format`           | Prettier                                       |

## Layout

- `apps/server`: Fastify 5 API, Kysely migrations
- `apps/web`: Vite + React client
- `packages/shared`: zod schemas and the WebSocket protocol, shared by both
- `examples`: echo bot, Uptime Kuma recipe, webhook script
- `deploy/nginx`: reverse-proxy config template

Design decisions are tracked in [NOTES.md](NOTES.md).
