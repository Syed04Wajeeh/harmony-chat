# Harmony

A self-hosted, Discord-style team chat app: servers (guilds) with public and private channels, DMs, message history with keyset pagination, replies, reactions, mentions, pins, search, file uploads, unread counts and presence, delivered live over WebSockets and Redis pub/sub. Bots and integrations have a UI too: BOT/WEBHOOK badges, embed cards, slash commands with autocomplete and typed options, ephemeral replies, and settings screens for webhooks, bots (scopes, URLs, one-time secrets) and the event delivery log. Identity comes from Tailscale Serve, so there are no passwords or sign-up. The REST and WebSocket contract is in [docs/api/protocol.md](docs/api/protocol.md).

## Quickstart (Docker)

```sh
cp .env.example .env        # set POSTGRES_PASSWORD, PROXY_SHARED_SECRET, PUBLIC_ORIGIN
docker compose up -d --build
curl http://127.0.0.1:8470/healthz
```

For later deploys use `scripts/deploy.sh`, which also restarts the proxies when their bind-mounted config changed.

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
docker compose -f compose.dev.yml up -d --wait     # throwaway Postgres :15432, Redis :16379 (project harmony-dev)

export DATABASE_URL=postgres://harmony:dev@127.0.0.1:15432/harmony
export REDIS_URL=redis://127.0.0.1:16379
export NODE_ENV=development
export DEV_AUTH_LOGIN=you@example.com   # fake identity; only honored when NODE_ENV=development
export DEV_AUTH_NAME=You                # optional

pnpm --filter @harmony/server migrate
pnpm dev                    # server on :8080, Vite on :5173 (proxies /api including WebSockets)
```

Open http://localhost:5173. The Origin check applies in development too, and defaults to `http://localhost:5173`; set `PUBLIC_ORIGIN` if you use another host. The server refuses to start with `DEV_AUTH_LOGIN` set outside development. In development a `dev_login=name@example.com` cookie switches the identity per browser, which is how the e2e tests play two people (see [the trust model](docs/security/trust-model.md#development-mode)). Tear down with `docker compose -f compose.dev.yml down -v`; it never touches the production `harmony` project.

To try it on a phone, run Vite with `--host` and open the machine's LAN address; set `PUBLIC_ORIGIN` to that exact origin. Add it to the home screen for the standalone app look (web manifest, no service worker).

### Tests

```sh
pnpm test:unit          # server + web (Vitest, Testing Library)
pnpm test:integration   # Testcontainers, needs Docker
pnpm test:e2e           # Playwright: two users, mobile drawer, long-press sheet, uploads, webhooks, bots
```

`pnpm test:e2e` needs the dev Postgres/Redis above and a Chromium (`pnpm --filter @harmony/web exec playwright install chromium`). Playwright starts the API in development mode (with `OUTBOUND_PRIVATE_ALLOWLIST=localhost,127.0.0.1`) and Vite on 127.0.0.1:18080 / :15173 itself, or reuses them if they are running. The bot test runs `examples/echo-bot` against that API; it needs the instance admin, which is the first user in an empty database, and skips itself otherwise. CI runs the same suite in its `e2e` job against Postgres and Redis service containers.

To run the browser inside Docker instead (useful on a headless server), start the API and Vite yourself, then:

```sh
docker run --rm --network host -e E2E_NO_WEBSERVER=1 -e E2E_BASE_URL=http://localhost:15173 \
  -v "$PWD":/work -w /work/apps/web mcr.microsoft.com/playwright:v1.64.1-noble \
  npx playwright test -c e2e/playwright.config.ts
```

### Screenshots

`E2E_SCREENSHOTS=1 pnpm --filter @harmony/web test:e2e` seeds a fictional book club (Ada, Linus, Grace, Margaret, Alan, all `@example.com`) into an empty dev database and rewrites `docs/screenshots/`. Start from a fresh database, since the first user created is the instance admin. The integrations shots (a "Home Lab" server with Uptime Kuma and job-scan webhooks, an echo bot and its delivery log) also need the event worker running (`pnpm --filter @harmony/server exec tsx src/worker.ts` with the same `DATABASE_URL`, `OUTBOUND_PRIVATE_ALLOWLIST=localhost,127.0.0.1`) so the log has deliveries. The web client reads an optional `VITE_DOCS_BASE_URL` at build time to link the integration guides. Icons in `apps/web/public` are rasterized from `icon.svg` with `apps/web/scripts/make-icons.mjs`.

| Command                 | What it does                                   |
| ----------------------- | ---------------------------------------------- |
| `pnpm lint`             | ESLint (typescript-eslint, type-checked rules) |
| `pnpm typecheck`        | `tsc` across all workspaces                    |
| `pnpm test:unit`        | Vitest unit tests (server, web, desktop)       |
| `pnpm test:integration` | Vitest + Testcontainers (needs Docker)         |
| `pnpm build`            | Build shared, server, web and desktop page     |
| `pnpm format`           | Prettier                                       |

## Desktop app

Installers for Windows (`.exe` and `.msi`), macOS (Apple silicon `.dmg`) and Linux (`.AppImage` and `.deb`) are attached to the [GitHub releases](https://github.com/Syed04Wajeeh/harmony-chat/releases). The app is a small [Tauri](https://tauri.app) shell (about 10 MB, it uses the system webview): on first start it asks for your Harmony server URL, checks that it answers like Harmony, and then shows the server in its own window with a tray icon, launch at login, native notifications for mentions and DMs, an unread badge and auto-update.

It loads the server itself instead of bundling the web client, so sign-in is still your Tailscale identity (the PC has to be connected to Tailscale), the server's origin checks pass unchanged, and the UI always matches the server version. The cost is that it does not work offline. Details, build and release steps: [apps/desktop/README.md](apps/desktop/README.md); the bridge's security model: [docs/security/trust-model.md](docs/security/trust-model.md#desktop-app).

Things to know:

- **Unsigned installers.** There are no code-signing certificates yet. Windows SmartScreen shows "Unknown publisher" (More info, then Run anyway) and macOS Gatekeeper blocks the first launch (right-click the app, choose Open). How to add signing later is in the desktop README.
- **Private repository.** While this repository is private, the update check (`releases/latest/download/latest.json`) cannot be fetched without authentication, so auto-update does nothing and fails silently. It starts working once the repository is public or the release files are mirrored.
- **Download link in the web app.** Build the server image with `VITE_RELEASES_URL` (for example `docker compose build --build-arg VITE_RELEASES_URL=https://github.com/Syed04Wajeeh/harmony-chat/releases/latest`) to show a "Desktop app" page with a download button in user settings. It is hidden when unset.

## Modules

Reactions, pins, search, uploads, polls and a coin flip are modules, not core code: each is a folder with one object that registers routes, WebSocket frames, slash commands, message data, migrations and per-server settings through a small typed context, and an optional matching folder in the web client for the UI slots (message accessories, composer actions, header buttons, settings pages). Server owners switch optional modules on and off in Server settings, Modules, which also builds a settings form from each module's schema; operators can turn any module off for the whole instance with `MODULES_DISABLED=polls,coinflip`. Adding a module is one import line plus a folder: the walkthrough in [docs/modules.md](docs/modules.md) builds `/coinflip` in about 30 lines, and `apps/server/src/modules/polls` (with `apps/web/src/modules/polls`) is a complete example with its own tables, live updates, a composer dialog and a `/poll` command.

| Phone                                     |                                                           |                                                 |
| ----------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| ![Poll](docs/screenshots/mobile-poll.png) | ![Create a poll](docs/screenshots/mobile-poll-create.png) | ![Modules](docs/screenshots/mobile-modules.png) |

![Poll on desktop](docs/screenshots/desktop-poll.png)
![Create a poll on desktop](docs/screenshots/desktop-poll-create.png)
![Modules settings on desktop](docs/screenshots/desktop-modules.png)

## Scaling & performance

The production compose file runs two identical app instances behind nginx (`least_conn`, no sticky sessions: all fan-out goes through Redis and all state is in Postgres and Redis). `docs/performance.md` has the measured results from an isolated copy of the stack: cross-instance delivery with 0 lost and 0 duplicated messages, failover when an instance is killed or recreated, fan-out latency, connection capacity and history throughput, each with its conditions and limits, plus how to reproduce them (`pnpm load:up`, `pnpm load:test`, `pnpm load:failover`, `pnpm load:down`). See [docs/performance.md](docs/performance.md).

## Layout

- `apps/server`: Fastify 5 API, Kysely migrations, `src/modules` (the module system and the modules)
- `apps/web`: Vite + React client (`src/modules` holds the UI side of modules) (React Router, zustand, plain CSS with design tokens, PWA manifest)
- `apps/desktop`: Tauri v2 desktop app that opens your server in its own window
- `packages/shared`: zod schemas and the WebSocket protocol, shared by both
- `examples`: echo bot, Uptime Kuma recipe, webhook script
- `deploy/nginx`: reverse-proxy config template
- `deploy/load`, `loadtest`: isolated load-test stack, k6 scenarios, failover and cross-instance scripts

## Screenshots

| Phone                                                           |                                               |                                                         |
| --------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| ![Channel](docs/screenshots/mobile-channel.png)                 | ![Drawer](docs/screenshots/mobile-drawer.png) | ![Message actions](docs/screenshots/mobile-actions.png) |
| ![Replies and reactions](docs/screenshots/mobile-reactions.png) | ![Image](docs/screenshots/mobile-image.png)   | ![Composer](docs/screenshots/mobile-keyboard.png)       |

![Desktop](docs/screenshots/desktop-channel.png)

### Bots and integrations

| Phone                                                                  |                                                            |                                                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| ![Uptime Kuma alerts](docs/screenshots/mobile-embeds-alerts.png)       | ![Job scan embed](docs/screenshots/mobile-embeds-jobs.png) | ![Slash autocomplete](docs/screenshots/mobile-slash-autocomplete.png) |
| ![Ephemeral reply](docs/screenshots/mobile-ephemeral-reply.png)        | ![Bot settings](docs/screenshots/mobile-bot-settings.png)  | ![Delivery log](docs/screenshots/mobile-delivery-log.png)             |
| ![New webhook, shown once](docs/screenshots/mobile-webhook-create.png) |                                                            |                                                                       |

![Alerts on desktop](docs/screenshots/desktop-embeds-alerts.png)
![Webhook URL, shown once](docs/screenshots/desktop-webhook-create.png)
![Bot settings on desktop](docs/screenshots/desktop-bot-settings.png)
![Delivery log on desktop](docs/screenshots/desktop-delivery-log.png)

Appearance (theme, density, flat or floating panels) is a user setting; the design tokens behind it are documented in [docs/theming.md](docs/theming.md). Light theme, compact and flat variants, member list, search and the invite page are in [docs/screenshots](docs/screenshots) (`desktop-light-*`, `mobile-light-*`, `desktop-compact.png`, `desktop-flat.png`, `desktop-appearance.png`).

Design decisions are tracked in [NOTES.md](NOTES.md).
