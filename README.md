# Harmony

Self-hosted team chat: servers, channels, DMs, roles, polls, bots and webhooks, plus a place to watch and steer AI agents. You sign in with your Tailscale identity, so there are no passwords. It runs as two app instances that share messages over Redis pub/sub.

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
  <tr>
    <td><img src="docs/screenshots/desktop-dashboard.png" alt="A dashboard channel with stats, a chart, a status list and buttons"><br><sub>Dashboard channel</sub></td>
    <td><img src="docs/screenshots/desktop-agent-run.png" alt="A live agent run panel waiting for approval, with a Cancel button"><br><sub>Agent run panel</sub></td>
    <td><img src="docs/screenshots/desktop-agent-approval.png" alt="An approval request message with Approve and Deny buttons"><br><sub>Approval request</sub></td>
    <td><img src="docs/screenshots/mobile-dashboard.png" alt="The dashboard on a phone" width="200"><br><sub>Dashboard on a phone</sub></td>
  </tr>
</table>

## What it is

Harmony is chat for a small group: a family, a team, a homelab. Your device already has a Tailscale identity, and Harmony uses it. The app reads that identity behind a reverse proxy and never stores a password.

You get what you'd expect from a chat app (servers, public and private channels, DMs, replies, reactions, mentions, search, uploads, unread counts, presence), and on top of that roles, per-user themes, bots with dashboards, an agent hub and an optional desktop app.

I built it to learn the engineering around a realtime system, and to show it: running more than one instance, measuring it under load, and writing down what it trusts and why.

## What's interesting about it

### Sign-in without passwords

Tailscale Serve sets identity headers on every request, and Harmony trusts them. Before relying on that I checked how Serve handles those headers, both in its source (v1.102.3) and against a live endpoint. nginx adds a shared secret so nothing else on the Docker network can pretend to be a user. Every state-changing request and every WebSocket upgrade has to carry the expected `Origin`, which blocks CSRF and cross-site WebSocket hijacking. The reasoning is in the [trust model](docs/security/trust-model.md).

### Two instances over Redis

Two identical app instances sit behind nginx, with no sticky sessions. Every delivery goes through Redis, even to a socket on the same instance, so there's only one code path.

On one host, 1,000 messages sent half through each instance reached both clients with 0 lost and 0 duplicated, at p50 3 ms and p95 5 ms. I also ran `docker kill` on one instance mid-run (20 receivers, about 100 messages a second). Clients reconnected to the other instance, and in the valid runs no receiver was missing a persisted message. Sends that were in flight when the instance died failed with 502 and were never saved. Details are in [performance](docs/performance.md).

### What load testing found

Three results from the load tests:

- A send cost 12 Postgres statements, and the outbox worker woke up once per notification. Getting that down to 6 statements raised the highest rate I could hold under a 100 ms p95 from 500 to 900 msg/s, and the saturation point from about 698 to about 1,010 to 1,023 msg/s (two instances, 10 receivers per message). At a 750 msg/s target, p95 dropped from 1,509 ms to 6 ms.
- Adding roles made sends slower, and nothing obvious showed why. A 900 msg/s run fell to 741 to 815.6 msg/s with p50 around 1 s, yet the statement count hadn't changed and `EXPLAIN ANALYZE` looked fine. A/B runs against `main`, plus `pg_stat_statements` with planning time switched on, showed that the extra joins in one query cost 1.361 ms of planning on every send, because the driver sends that query unprepared. Serving nicknames from the permission cache brought it back to 897.2 to 898.1 msg/s at p95 11 to 12 ms.
- Presence was broadcast to every socket, which grows quadratically. After scoping it to guilds and DMs and batching it once a second, a 10,000-connection test went from stalling at 5,151 (1.00 % failures, handshake p95 10,995 ms) to all 10,000 connected with 0 failures (handshake p95 29 ms). Presence frames received fell from 96,328/s to 2,942/s.

All of this ran on one host, with the load generator on the same machine. The conditions for each number are in [docs/performance.md](docs/performance.md).

### Bots and integrations

Bots are users with scoped tokens, and only a hash of each token is stored.

Incoming webhooks accept Discord's payload, which I checked against Uptime Kuma's source ([recipe](examples/uptime-kuma.md)). Presets and declarative templates turn Forgejo, GitHub, Alertmanager, Grafana, Watchtower or any other JSON into messages, with optional signature checks and a live preview ([guide](docs/integrations.md#webhook-presets-and-templates)).

Slash commands reach a bot as signed requests, with the timestamp inside the HMAC. Outgoing events go through a transactional outbox and are delivered at least once, retried with exponential backoff and jitter until they're marked `dead`. A bot without a URL can instead connect out over the WebSocket and receive commands, button clicks and numbered events it acknowledges and can resume from ([guide](docs/integrations.md#building-a-gateway-bot)). Any request to a user-supplied URL goes through an SSRF guard that pins the resolved address.

Bots can publish dashboards: stats, charts, tables, status lists and buttons, as declarative panels that Harmony renders with the current theme. They go in dashboard channels or pinned above a text channel ([guide](docs/integrations.md#panels-and-buttons)). Managers can assign bots to a channel and make it a feed where only bots and moderators post. Bots can register interval or cron schedules and get a signed `refresh` when it's time to update their panels ([guide](docs/integrations.md#scheduling-refreshes)).

More: the [API](docs/api/protocol.md), [bot security](docs/security/trust-model.md#bots-and-integrations), the [ingress](docs/integrations.md), the [echo bot](examples/echo-bot/README.md) and the [homelab bot](examples/homelab-bot/README.md), which runs Docker containers, game servers and monitors through a locked-down socket proxy.

### AI agents

An [MCP server](packages/mcp/README.md) lets agents such as Claude Code read channels, post and ask people questions, using an ordinary bot token. An agent can ask for approval with Approve and Deny buttons and show a live run panel with a Cancel button. A Claude Code hook sends risky commands to a person before they run, and bot-to-bot reply chains are capped so two agents can't talk forever ([guide](docs/agents.md)).

The [agent control room](docs/agents.md#agent-control-room) shows every Claude Code session and each of its subagents as a panel, and people can stop, pause or steer them from chat.

### Modules

Reactions, pins, search, uploads, polls, custom emoji and a coin flip are all modules. A module is a folder that registers routes, WebSocket frames, slash commands, migrations, message data and settings through a typed context. A test checks that the send path costs the same with and without them. Polls are the full example, with server code, tables and UI ([modules](docs/modules.md)).

### Roles and permissions

Roles have positions and per-channel overwrites. One pure function resolves them, and both server and client tests use it. The [permissions doc](docs/permissions.md) has a worked example and the hierarchy rules.

### Customization

Themes are validated data over an allowlist of tokens, with a contrast checker that can fix colors for you. Custom CSS is opt-in and sanitized on both the server and the client. There are also profiles, custom emoji, server branding and perks an admin can grant ([customization](docs/customization.md), [theming](docs/theming.md)).

### Desktop app

A Tauri v2 shell loads your server's own origin, so identity and `Origin` checks work exactly as in a browser. The page can call only a short fixed list of native commands: notify, set the badge, the window controls for the custom Windows title bar, and disconnect ([desktop](apps/desktop/README.md), [bridge security](docs/security/trust-model.md#desktop-app)).

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

People come in through Serve and the user proxy, and that proxy is the only thing holding the proxy secret. Machines come in through a separate proxy that blanks every identity header, so a request there can only act as a bot or a webhook. Postgres and Redis publish no ports. Migrations run in a one-shot `migrate` service before the app instances start.

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

The sender's socket gets both the ack and the broadcast with the same message id, and the client keeps one. When a client reconnects it subscribes with the last id it saw. The server joins the Redis channel first and then backfills from Postgres. A message published in that gap can arrive twice, once live and once in the backfill, but it can't go missing, and the client dedupes by id. The reasons behind these choices are in [NOTES.md](NOTES.md).

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

You need Docker, and Tailscale on the host if you want sign-in to work.

```sh
cp .env.example .env     # set POSTGRES_PASSWORD, PROXY_SHARED_SECRET (openssl rand -hex 32), PUBLIC_ORIGIN
docker compose up -d --build
curl http://127.0.0.1:8470/healthz
```

Point Tailscale Serve at nginx, and set `PUBLIC_ORIGIN` to the exact URL your browser uses:

```sh
tailscale serve --bg --https=18470 http://127.0.0.1:8470
# PUBLIC_ORIGIN=https://chat.example.ts.net:18470
```

`ALLOWED_LOGINS` (comma-separated) limits access to specific tailnet users. Leave it empty to let anyone on the tailnet in. The first person to sign in becomes the instance admin and gets a starter server. Everyone after that joins no server until the admin picks a lobby server (Settings, Instance), but they can find each other under Home, All members, and invite people to a server by DM. To call the API without Serve, send the header Serve would add: `curl -H 'Tailscale-User-Login: you@example.com' http://127.0.0.1:8470/api/me`.

To update later, run `scripts/deploy.sh`. It rebuilds, recreates the containers, and restarts the proxies when their bind-mounted config has changed, which compose doesn't notice on its own. Scripts on the host reach Harmony at `127.0.0.1:8471`; see [docs/integrations.md](docs/integrations.md).

## Local development

You need Node 24, pnpm 12 (`corepack enable pnpm`) and Docker.

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

Then open http://localhost:5173. In development a `dev_login=name@example.com` cookie sets who you are in that browser, which is how the e2e tests play several users. The server won't start with `DEV_AUTH_LOGIN` set outside development ([details](docs/security/trust-model.md#development-mode)). `docker compose -f compose.dev.yml down -v` deletes the dev data. To try it on a phone, run Vite with `--host` and set `PUBLIC_ORIGIN` to that origin.

### Tests

| Command                 | Covers                                                                                                                                                                                            | Count                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm test:unit`        | Pure logic, permissions, theme and CSS sanitizing, SSRF rules, the web store and components (Vitest, Testing Library), desktop page                                                               | 1246 (732 server, 276 web, 27 desktop, 148 mcp, 63 homelab bot) |
| `pnpm test:integration` | Real Postgres, Redis and nginx via Testcontainers (needs Docker): migrations, REST, the hub with two instances, webhooks, bots, the worker, modules                                               | 472                                                             |
| `pnpm test:e2e`         | Playwright against the dev stack: two users, mobile drawer and long-press sheet, uploads, polls, roles, profiles, webhooks, bots; needs `playwright install chromium`                             | specs in `apps/web/e2e`, run in CI                              |
| `pnpm load:test`        | k6 and Node scripts against an isolated two-instance stack (`pnpm load:up` first, `pnpm load:down` after); also `pnpm load:failover`. Steps: [docs/performance.md](docs/performance.md#reproduce) | see [performance](docs/performance.md)                          |

The unit and integration counts come from running both commands on this checkout. CI also runs `pnpm lint`, `pnpm typecheck`, `pnpm build`, a link check (`node scripts/check-links.mjs`), a Docker image build, and `cargo fmt`, `clippy` and `cargo test` for the desktop app.

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
examples/      echo bot, homelab operations bot, Uptime Kuma recipe, curl script for webhooks
docs/          API, security, performance, modules, permissions, theming, screenshots
scripts/       deploy.sh, check-links.mjs
```

## Documentation

| Document                                                       | What is in it                                                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/codebase-map.md](docs/codebase-map.md)                   | Maintainer's index: where everything lives, recipes for common changes, invariants, testing map                                                       |
| [CLAUDE.md](CLAUDE.md)                                         | Short brief for AI coding assistants: commands, invariants, conventions, safety                                                                       |
| [docs/api/protocol.md](docs/api/protocol.md)                   | REST endpoints, WebSocket frames, bot and webhook API                                                                                                 |
| [docs/security/trust-model.md](docs/security/trust-model.md)   | Why header auth is safe here, Origin checks, bots, SSRF, custom CSS, the desktop bridge                                                               |
| [docs/performance.md](docs/performance.md)                     | Every measurement with its conditions, the investigations, how to reproduce                                                                           |
| [docs/modules.md](docs/modules.md)                             | The module contract and a guide to writing one                                                                                                        |
| [docs/permissions.md](docs/permissions.md)                     | Roles, overwrites, resolution order, hierarchy                                                                                                        |
| [docs/theming.md](docs/theming.md)                             | Design tokens, themes as data, custom CSS                                                                                                             |
| [docs/customization.md](docs/customization.md)                 | What users, server managers and admins can change                                                                                                     |
| [docs/integrations.md](docs/integrations.md)                   | The machine ingress, webhook presets and templates, gateway bots, panels, schedules                                                                   |
| [docs/agents.md](docs/agents.md)                               | The MCP server, approvals, run panels, the Claude Code hook and bot loop limits                                                                       |
| [CHANGELOG.md](CHANGELOG.md)                                   | What changed in each release, with migration notes                                                                                                    |
| [examples/](examples/uptime-kuma.md)                           | [Uptime Kuma](examples/uptime-kuma.md), [echo bot](examples/echo-bot/README.md), [homelab bot](examples/homelab-bot/README.md), `post-from-script.sh` |
| [apps/desktop/README.md](apps/desktop/README.md)               | Building, releasing and signing the desktop app                                                                                                       |
| [NOTES.md](NOTES.md)                                           | Dated design decisions with rejected alternatives, measured results, problems solved                                                                  |
| [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) | Contributing and reporting vulnerabilities                                                                                                            |

## Desktop app

Installers for Windows (`.exe`, `.msi`), macOS (Apple silicon `.dmg`) and Linux (`.AppImage`, `.deb`) are on the [Releases page](https://github.com/Syed04Wajeeh/harmony-chat/releases). The first time it starts, the app asks for your Harmony server's URL and then opens that server in its own window. It has a tray icon, launch at login, native notifications for mentions and DMs, an unread badge and auto-update. Tailscale has to be running on the machine, and it doesn't work offline.

The installers aren't code-signed. On Windows, SmartScreen shows "Unknown publisher": click More info, then Run anyway. On macOS, Gatekeeper blocks the first launch: right-click the app and choose Open. More in [apps/desktop/README.md](apps/desktop/README.md).

## Limitations

- It runs on one host, as Docker Compose on a single machine. The second app instance gives failover and more connection capacity, not more write throughput. Postgres was the limit in every measurement, and two instances were no faster than one at the rates I tested ([why](docs/performance.md#one-instance-versus-two)). There's no database replication and no Redis persistence.
- The measurements come from one shared home server, with the load generator on the same machine, TLS and Serve bypassed, and mostly one run per setting. The [limits section](docs/performance.md#limitations) of the performance doc has the details.
- Unread counts don't scale with total messages in some data shapes. With 599,998 messages packed into a few busy channels, `GET /api/guilds` took 221 ms at p50. The analysis, an index I rejected, and a proposed counter design are in [docs/performance.md](docs/performance.md#unread-counts-analysis-only-not-fixed). It isn't fixed yet.
- Presence can lag by up to a second (the batch window, `PRESENCE_BATCH_MS`). I haven't measured that end to end.
- Messages aren't end-to-end encrypted, so the server can read them. What you're trusting in the host and in Tailscale's control plane is written up in the [trust model](docs/security/trust-model.md#what-we-trust-residual-risk).
- There's no voice or video.
- Embed images load straight from the sender's URL, so that image host sees readers' IP addresses ([NOTES](NOTES.md)).
- The desktop installers are unsigned (see above).

## Roadmap

- SDKs and a CLI for bots and scripts.
- A developer console and an OpenAPI description of the REST API.
- ChatOps workflows.
- Sandboxed scripting (webhook templates are data only today).
- Voice and video.
- Maintained unread counters, if the measured unread cost starts to matter.

## License

[MIT](LICENSE)
