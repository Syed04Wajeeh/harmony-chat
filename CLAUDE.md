# Harmony

Self-hosted team chat: servers (guilds), channels, DMs, roles, polls, a bot and webhook API.
Sign-in is the Tailscale identity behind a reverse proxy; no passwords. TypeScript pnpm monorepo:
`apps/server` (Fastify, `ws`, Kysely), `apps/web` (React, Vite, zustand), `apps/desktop` (Tauri),
`packages/shared` (zod schemas and protocol), plus `deploy`, `loadtest`, `examples`, `docs`.

**First read: [docs/codebase-map.md](docs/codebase-map.md)** (directory index, "Where is X?" table,
recipes, invariants, testing map). Then the doc for the area you touch in `docs/`.

## Commands

```sh
pnpm install
docker compose -f compose.dev.yml up -d --wait && pnpm --filter @harmony/server migrate   # dev DB
pnpm dev                    # server :8080, Vite :5173 (needs the env in README "Local development")
pnpm build:shared           # required after editing packages/shared (server and web read its dist)
pnpm test:unit              # fast; pnpm test:integration needs Docker (Testcontainers)
pnpm test:e2e               # Playwright against the dev stack; pnpm screenshots rewrites docs/screenshots
pnpm lint && pnpm typecheck
npx prettier --check .      # pnpm format to fix
node scripts/check-links.mjs  # every relative Markdown link and anchor
scripts/deploy.sh           # roll out the stack
```

One test file: `pnpm --filter @harmony/server exec vitest run --project unit tests/unit/<file>`
(use `--project integration` for integration files).

## Invariants (details and enforcing tests in the map)

- [ ] Sending a message stays at 6 SQL statements or fewer (`modules-hotpath.test.ts`).
- [ ] Never wait on the DB pool inside a transaction: warm caches and look up perks first.
- [ ] No color literals in component CSS; tokens only (`styles.test.ts`).
- [ ] The theme token allowlist (`packages/shared/src/theme.ts`) matches `tokens.css`.
- [ ] Every realtime delivery goes through Redis, even to sockets on the same instance.
- [ ] Caches (permissions, modules, emoji, perks) are invalidated over Redis after writes.
- [ ] Writes and WebSocket upgrades require the exact `Origin`; bot tokens ignore Tailscale headers.
- [ ] Requests to user-supplied URLs go only through `safeFetch` (SSRF guard).
- [ ] The outbox row is written in the same transaction as the change.
- [ ] nginx config is bind-mounted: changing it needs a proxy restart (`scripts/deploy.sh` does it).
- [ ] Docs state only numbers that were measured, with their conditions.

## Conventions

- TypeScript strict. Protocol and API shapes start as zod schemas in `packages/shared`.
- Migrations are raw SQL through Kysely `sql` templates, append-only; core in `apps/server/migrations`,
  module-owned in `apps/server/src/modules/<id>/migrations`.
- Feature folders on the server (`routes.ts` thin, logic in `service.ts`); extra features are modules.
- Comments are sparse and explain why, not what. Plain CSS with tokens.
- Commits: short imperative subject, a body only when the reason is not obvious, one logical
  change per commit, no AI trailers or attribution lines.
- Update the matching doc (protocol, permissions, theming, trust model) and `docs/codebase-map.md`
  when a change moves or adds something it lists.

## Working on a live deployment

- Never run `docker compose down -v`; it deletes the database and uploads volumes.
- Back up Postgres before deploying a migration; migrations only move forward.
- Edit nginx config only with a restart in mind (`scripts/deploy.sh`); do not hand-restart one proxy.
- Do not commit `.env`, `docker-compose.override.yml` or load-test `.work` output; keep secrets out of docs.
- Test against the dev stack (`compose.dev.yml`) or the isolated `harmony-load` stack, never the live one.
