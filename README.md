# Harmony

A self-hosted, Discord-style team chat app. Phase 0: project skeleton (server, web client, shared protocol schemas, Docker stack, CI). Full docs coming.

## Quickstart (Docker)

```sh
cp .env.example .env        # then set POSTGRES_PASSWORD
docker compose up -d --build
curl http://127.0.0.1:8470/readyz
```

The app is published on `127.0.0.1:8470` only. Postgres and Redis stay on the internal network. A one-shot `migrate` service applies database migrations before the app starts.

## Development

Requires Node 24 and pnpm 12 (`corepack enable pnpm`).

```sh
pnpm install
export DATABASE_URL=postgres://harmony:<password>@localhost:5432/harmony
export REDIS_URL=redis://localhost:6379
pnpm --filter @harmony/server migrate
pnpm dev                    # server on :8080, Vite dev server with proxy
```

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
- `packages/shared`: zod schemas shared by both

Design decisions are tracked in [NOTES.md](NOTES.md).
