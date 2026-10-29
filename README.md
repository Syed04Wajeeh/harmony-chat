# Harmony

A self-hosted team chat with servers, channels, DMs, roles, polls and a bot API. Sign-in is your Tailscale identity, so there are no passwords, and it runs as two app instances over Redis pub/sub.

[![CI](https://github.com/Syed04Wajeeh/harmony-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/Syed04Wajeeh/harmony-chat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6.svg)

![Harmony on desktop: a server with channels, a reply thread, reactions, a file attachment and a member list](docs/screenshots/desktop-channel.png)

<table>
  <tr>
    <td><img src="docs/screenshots/desktop-light-channel.png" alt="Light theme"><br><sub>Light theme</sub></td>
    <td><img src="docs/screenshots/mobile-channel.png" alt="Mobile layout" width="200"><br><sub>Phone layout</sub></td>
    <td><img src="docs/screenshots/desktop-theme-editor.png" alt="Theme editor with contrast checker"><br><sub>Theme editor and contrast checker</sub></td>
    <td><img src="docs/screenshots/desktop-roles.png" alt="Role editor"><br><sub>Roles</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/desktop-poll.png" alt="A poll in a channel"><br><sub>Poll module</sub></td>
    <td><img src="docs/screenshots/desktop-embeds-alerts.png" alt="Uptime Kuma alerts as embeds"><br><sub>Webhook embeds</sub></td>
    <td><img src="docs/screenshots/desktop-profile-popover.png" alt="Profile card"><br><sub>Profile card</sub></td>
    <td><img src="docs/screenshots/desktop-delivery-log.png" alt="Bot event delivery log"><br><sub>Bot delivery log</sub></td>
  </tr>
</table>

## What it is

Harmony is a chat server for a small group, such as a family, a team or a homelab. People sign in with the Tailscale identity their device already has; the app checks it behind a reverse proxy and never stores a password. It has the usual features (servers, public and private channels, DMs, replies, reactions, mentions, search, uploads, unread counts, presence) plus roles, per-user themes, a bot and webhook platform, and an optional desktop app. It was built to learn and to show the engineering around a realtime system: scaling it out, measuring it, and writing down what is trusted and why.

## Highlights

1. **Passwordless auth with a written trust model.** Identity comes from the headers Tailscale Serve sets. Serve's header handling was checked against its source (v1.102.3) and against a live endpoint, nginx adds a shared secret so nothing else on the Docker network can forge identity, and every state-changing request and WebSocket upgrade must carry the expected `Origin`, which stops CSRF and cross-site WebSocket hijacking. [Trust model](docs/security/trust-model.md).
2. **Horizontal scaling over Redis pub/sub.** Two identical app instances sit behind nginx with no sticky sessions. Every delivery goes through Redis, including to sockets on the same instance. Measured on one host: 1,000 messages sent half through each instance were received by both clients with 0 lost and 0 duplicated, latency p50 3 ms and p95 5 ms. With `docker kill` on one instance mid-run (20 receivers, about 100 messages/s), clients reconnected to the other and no persisted message was missing at any receiver in the valid runs; sends in flight at the moment of the kill failed with 502 and were not persisted. [Performance](docs/performance.md).
3. **Measured performance, and what the measurements found.**
   - _Send path:_ profiling showed a send cost 12 Postgres statements and the outbox worker woke once per notification. Cutting that to 6 statements raised the highest tested rate with p95 under 100 ms from 500 to 900 msg/s, and the saturation ceiling from about 698 to about 1,010 to 1,023 msg/s (two instances, 10 receivers per message). At a 750 msg/s target p95 went from 1,509 ms to 6 ms.
   - _Regression:_ adding roles dropped a 900 msg/s run to 741 to 815.6 msg/s with p50 around 1 s, with an unchanged statement count and a good `EXPLAIN ANALYZE`. A/B runs against `main` and `pg_stat_statements` with planning time on showed the extra joins in one query cost 1.361 ms of planning per send (the driver sends it unprepared). Serving nicknames from the permission cache restored 897.2 to 898.1 msg/s at p95 11 to 12 ms.
   - _Presence:_ broadcasting presence to every socket was quadratic. Scoping it to guilds and DMs and batching it over one second took 10,000 concurrent connections from stopping at 5,151 (1.00 % failures, handshake p95 10,995 ms) to 10,000 connected with 0 failures (handshake p95 29 ms), and presence frames received from 96,328/s to 2,942/s.
   - All of these are one host with the load generator on the same machine; conditions are in [docs/performance.md](docs/performance.md).
4. **A bot and integration platform.** Bots are users with scoped tokens (only a hash is stored). Incoming webhooks accept Discord's payload, checked against Uptime Kuma's source ([recipe](examples/uptime-kuma.md)). Slash commands go to the bot as signed requests (HMAC with a timestamp inside the MAC). Outgoing events use a transactional outbox with at-least-once, retried delivery (exponential backoff with jitter, then `dead`). Requests to user-supplied URLs go through an SSRF guard that pins the resolved address. [API](docs/api/protocol.md), [security](docs/security/trust-model.md#bots-and-integrations), [ingress](docs/integrations.md), [echo bot](examples/echo-bot/README.md). **Panels and buttons**: bots publish declarative dashboards (stats, charts, tables, status lists, buttons) into dashboard channels or pinned above a text channel, rendered natively with theme tokens ([guide](docs/integrations.md#panels-and-buttons)).
5. **A module system.** Reactions, pins, search, uploads, polls, custom emoji and a coin flip are modules: a folder that registers routes, WebSocket frames, slash commands, migrations, message data and settings through a typed context, with a test that the send path costs the same with and without them. Polls are the vertical-slice example (server, tables, UI). [Modules](docs/modules.md).
6. **Roles and permissions.** Roles with positions, per-channel overwrites, and one pure function shared by server and client tests to resolve them, with a worked example and hierarchy rules. [Permissions](docs/permissions.md).
7. **Customization.** Themes are validated data over an allowlist of tokens, with a contrast checker and auto-fix; custom CSS is opt-in and sanitized on both server and client; plus profiles, custom emoji, server branding and admin-granted perks. [Customization](docs/customization.md), [theming](docs/theming.md).
8. **A desktop app.** Tauri v2 shell that loads your server's own origin, so identity and Origin checks are unchanged. Its IPC capability for your server is a short, fixed list (notify, set badge, window controls for the custom Windows title bar, disconnect). [Desktop](apps/desktop/README.md), [bridge security](docs/security/trust-model.md#desktop-app).

## Architecture

```mermaid
flowchart LR
  client["Browser / desktop app"] -->|HTTPS| serve["Tailscale Serve<br/>(sets identity headers)"]
  serve --> nginx["nginx, user proxy<br/>(adds proxy secret, least_conn)"]
  nginx --> app1["app1"]
  nginx --> app2["app2"]
  app1 <-->|"pub/sub, presence,<br/>caches, rate limits"| redis[("Redis")]
  app2 <--> redis
  app1 --> pg[("Postgres")]
  app2 --> pg
  app1 --- uploads[/"uploads volume"/]
  app2 --- uploads
  scripts["Homelab services<br/>and scripts"] -->|"webhooks, bot tokens"| integ["integrations proxy<br/>(no secret, 127.0.0.1 only)"]
  integ --> app1
  integ --> app2
  pg -->|"outbox rows + LISTEN/NOTIFY"| worker["worker"]
  worker -->|"signed, retried HTTP"| bots["Bots and<br/>webhook receivers"]
```

People enter through Serve and the user proxy, which is the only holder of the proxy secret. Machines enter through a separate proxy that blanks every identity header, so a request there can only act as a bot or a webhook. Postgres and Redis publish no ports. Migrations run in a one-shot `migrate` service before the app instances start.

```mermaid
sequenceDiagram
  participant C as Client
  participant A as App instance
  participant P as Postgres
  participant R as Redis
  participant O as Other instance
  C->>A: message.send (nonce)
  A->>A: validate, check permission, rate limit
  A->>P: one transaction: insert message + outbox row
  P-->>A: commit
  A->>R: PUBLISH channel topic
  R-->>A: message
  R-->>O: message
  A-->>C: message.created to subscribed sockets
  O-->>C: message.created to its subscribed sockets
  A-->>C: ack (nonce, message)
```

The sender's own socket gets both the ack and the broadcast with the same message id and the client keeps one. On reconnect a client subscribes with its last seen id: the server joins the Redis channel first and then backfills from Postgres, so a message published in between may arrive twice (live and in the backfill) but is not lost, and the client dedupes by id. Why these choices were made: [NOTES.md](NOTES.md).

## Tech stack

| Area      | Choice                                                   | Why                                                                                                                                            |
| --------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Language  | TypeScript 6 on Node 24, pnpm monorepo                   | One language end to end; a shared zod package means protocol drift is a compile error ([NOTES](NOTES.md)).                                     |
| Server    | Fastify 5, raw `ws`                                      | Small typed protocol that I wanted to own, rather than Socket.IO's rooms and framing ([NOTES](NOTES.md)).                                      |
| Database  | Postgres 16 with Kysely                                  | Queries and migrations stay close to SQL; no generated client or engine binary. Full-text search uses a stored `tsvector` and a GIN index.     |
| Realtime  | Redis 7 pub/sub, Lua scripts for presence                | One delivery path for local and remote sockets; atomic presence transitions decided inside Redis.                                              |
| Web       | React, Vite, zustand, React Router, Radix, plain CSS     | One normalized store fed by REST and WebSocket frames; CSS custom properties make themes data ([NOTES](NOTES.md), [theming](docs/theming.md)). |
| Desktop   | Tauri v2 (Rust)                                          | A thin shell using the system webview instead of bundling Chromium ([NOTES](NOTES.md)).                                                        |
| Edge      | Tailscale Serve, nginx                                   | Serve gives TLS and identity; nginx adds the secret, balances with `least_conn` and keeps the machine ingress separate.                        |
| Testing   | Vitest, Testing Library, Testcontainers, Playwright, k6  | Real Postgres, Redis and nginx in integration tests; k6 for the load numbers.                                                                  |
| Packaging | Docker Compose, GitHub Actions (CI and desktop releases) | The whole stack is one compose file; images are pinned and upgraded deliberately.                                                              |

## Quickstart

Requires Docker, and Tailscale on the host if you want sign-in to work (see below).

```sh
cp .env.example .env     # set POSTGRES_PASSWORD, PROXY_SHARED_SECRET (openssl rand -hex 32), PUBLIC_ORIGIN
docker compose up -d --build
curl http://127.0.0.1:8470/healthz
```

Point Tailscale Serve at nginx and set `PUBLIC_ORIGIN` to the exact URL browsers use:

```sh
tailscale serve --bg --https=18470 http://127.0.0.1:8470
# PUBLIC_ORIGIN=https://chat.example.ts.net:18470
```

`ALLOWED_LOGINS` (comma-separated) restricts access to specific tailnet users; empty allows anyone on the tailnet. The first user to sign in becomes the instance admin. To call the API without Serve, send the header it would add: `curl -H 'Tailscale-User-Login: you@example.com' http://127.0.0.1:8470/api/me`.

For later updates run `scripts/deploy.sh`, which rebuilds, recreates the containers and restarts the proxies only when their bind-mounted config changed (compose does not notice that on its own). The host-local ingress for scripts is `127.0.0.1:8471`; see [docs/integrations.md](docs/integrations.md).

## Local development

Requires Node 24, pnpm 12 (`corepack enable pnpm`) and Docker.

```sh
pnpm install
docker compose -f compose.dev.yml up -d --wait   # throwaway Postgres :15432, Redis :16379

export DATABASE_URL=postgres://harmony:dev@127.0.0.1:15432/harmony
export REDIS_URL=redis://127.0.0.1:16379
export NODE_ENV=development
export DEV_AUTH_LOGIN=you@example.com            # fake identity, honored only in development

pnpm --filter @harmony/server migrate
pnpm dev                                         # server on :8080, Vite on :5173
```

Open http://localhost:5173. In development a `dev_login=name@example.com` cookie switches identity per browser, which is how the e2e tests play several users; the server refuses to start with `DEV_AUTH_LOGIN` set outside development ([details](docs/security/trust-model.md#development-mode)). `docker compose -f compose.dev.yml down -v` removes the dev data. For a phone, run Vite with `--host` and set `PUBLIC_ORIGIN` to that origin.

### Tests

| Command                 | Covers                                                                                                                                                                                            | Count                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `pnpm test:unit`        | Pure logic, permissions, theme and CSS sanitizing, SSRF rules, the web store and components (Vitest, Testing Library), desktop page                                                               | 883 (646 server, 229 web, 8 desktop)   |
| `pnpm test:integration` | Real Postgres, Redis and nginx via Testcontainers (needs Docker): migrations, REST, the hub with two instances, webhooks, bots, the worker, modules                                               | 347                                    |
| `pnpm test:e2e`         | Playwright against the dev stack: two users, mobile drawer and long-press sheet, uploads, polls, roles, profiles, webhooks, bots; needs `playwright install chromium`                             | specs in `apps/web/e2e`, run in CI     |
| `pnpm load:test`        | k6 and Node scripts against an isolated two-instance stack (`pnpm load:up` first, `pnpm load:down` after); also `pnpm load:failover`. Steps: [docs/performance.md](docs/performance.md#reproduce) | see [performance](docs/performance.md) |

The unit and integration counts are from running both commands on this checkout. CI also runs `pnpm lint`, `pnpm typecheck`, `pnpm build`, a link check (`node scripts/check-links.mjs`), a Docker image build, and the desktop app's `cargo fmt`, `clippy` and `cargo test`.

## Project structure

```
apps/
  server/      Fastify API, realtime hub, outbox worker, migrations, modules (src/modules)
  web/         React client; src/modules holds the UI side of modules; e2e/ is Playwright
  desktop/     Tauri v2 shell (Rust in src-tauri, a small setup page in src)
packages/
  shared/      zod schemas, WebSocket protocol, permission resolution, request signing
deploy/
  nginx/       user proxy and integrations proxy config
  load/        compose files for the isolated load-test stack
loadtest/      k6 scenarios, failover and cross-instance scripts, raw results
examples/      echo bot, Uptime Kuma recipe, curl script for webhooks
docs/          API, security, performance, modules, permissions, theming, screenshots
scripts/       deploy.sh, check-links.mjs
```

## Documentation

| Document                                                       | What is in it                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [docs/codebase-map.md](docs/codebase-map.md)                   | Maintainer's index: where everything lives, recipes for common changes, invariants, testing map        |
| [CLAUDE.md](CLAUDE.md)                                         | Short brief for AI coding assistants: commands, invariants, conventions, safety                        |
| [docs/api/protocol.md](docs/api/protocol.md)                   | REST endpoints, WebSocket frames, bot and webhook API                                                  |
| [docs/security/trust-model.md](docs/security/trust-model.md)   | Why header auth is safe here, Origin checks, bots, SSRF, custom CSS, the desktop bridge                |
| [docs/performance.md](docs/performance.md)                     | Every measurement with its conditions, the investigations, how to reproduce                            |
| [docs/modules.md](docs/modules.md)                             | The module contract and a guide to writing one                                                         |
| [docs/permissions.md](docs/permissions.md)                     | Roles, overwrites, resolution order, hierarchy                                                         |
| [docs/theming.md](docs/theming.md)                             | Design tokens, themes as data, custom CSS                                                              |
| [docs/customization.md](docs/customization.md)                 | What users, server managers and admins can change                                                      |
| [docs/integrations.md](docs/integrations.md)                   | The machine ingress for webhooks and bots                                                              |
| [examples/](examples/uptime-kuma.md)                           | [Uptime Kuma](examples/uptime-kuma.md), [echo bot](examples/echo-bot/README.md), `post-from-script.sh` |
| [apps/desktop/README.md](apps/desktop/README.md)               | Building, releasing and signing the desktop app                                                        |
| [NOTES.md](NOTES.md)                                           | Dated design decisions with rejected alternatives, measured results, problems solved                   |
| [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) | Contributing and reporting vulnerabilities                                                             |

## Desktop app

Installers for Windows (`.exe`, `.msi`), macOS (Apple silicon `.dmg`) and Linux (`.AppImage`, `.deb`) are on the [Releases page](https://github.com/Syed04Wajeeh/harmony-chat/releases). On first start the app asks for your Harmony server URL and shows that server in its own window, with a tray icon, launch at login, native notifications for mentions and DMs, an unread badge and auto-update. It needs Tailscale running on that machine and does not work offline.

The installers are not code-signed. Windows SmartScreen shows "Unknown publisher" (More info, then Run anyway) and macOS Gatekeeper blocks the first launch (right-click the app, choose Open). Details: [apps/desktop/README.md](apps/desktop/README.md).

## Limitations

- **One host.** The stack is Docker Compose on a single machine. Two app instances give failover and more connection capacity, not more write throughput: Postgres was the limit in the measurements, and two instances were no faster than one at the tested rates ([why](docs/performance.md#one-instance-versus-two)). There is no database replication or Redis persistence.
- **Measurements are from one shared home server**, with the load generator on the same machine, TLS and Serve bypassed, and mostly one run per cell. See the limits section of [docs/performance.md](docs/performance.md#limitations).
- **Unread counts do not scale with total messages in some data shapes.** With 599,998 messages concentrated in a few busy channels, `GET /api/guilds` took 221 ms at p50. The analysis, a rejected index and a proposed counter design are in [docs/performance.md](docs/performance.md#unread-counts-analysis-only-not-fixed); it is not fixed.
- **Presence lags by up to one second** (the batch window, `PRESENCE_BATCH_MS`). That was not measured end to end.
- **No end-to-end encryption.** The server can read messages. Trust in the host and in Tailscale's control plane is spelled out in the [trust model](docs/security/trust-model.md#what-we-trust-residual-risk).
- **No voice or video.**
- **Embed images are loaded straight from the sender's URL**, so the image host sees readers' IP addresses ([NOTES](NOTES.md)).
- **Desktop installers are unsigned** (above).

## Roadmap

- Maintained unread counters, if the measured unread cost starts to matter.
- Measure presence for DMs and delivery to larger channels under load; neither was part of the load worlds.
- Code-signing for the desktop installers.
- Voice and video.

## License

[MIT](LICENSE)
