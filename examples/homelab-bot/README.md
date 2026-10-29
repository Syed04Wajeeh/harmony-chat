# Homelab bot

A gateway-mode Harmony bot that shows a home server on a dashboard and lets the right people start,
stop and restart things from chat. It watches Docker containers (through a locked-down socket
proxy), game servers (through the Pterodactyl client API) and, optionally, an Uptime Kuma status
page. Nothing in this directory is specific to one household: the real container names, addresses
and keys live in files you keep out of git.

- **Dashboard.** Panels in a Dashboard channel: _Containers_ (state and uptime, with Restart, Stop
  or Start buttons for the ones you allow), _Game servers_ (state, CPU, memory, uptime, with power
  buttons) and _Monitors_ (Kuma). The bot rewrites them every 30 seconds (`refreshSeconds`) and only
  when something changed.
- **Slash commands.** `/status` and `/games` (answers only you see), and `/start`, `/stop`,
  `/restart` with a `target`: a container name, or a game server by its slug (`core_keeper` for a
  server called "Core Keeper"). Harmony has no autocomplete for options yet, so an unknown target is
  answered with a hint and `/status` lists the valid ones.
- **Safety.** Allowlists, a permission check in two places, confirm dialogs, a cooldown per target,
  an audit line in an ops channel for every action, and a Docker proxy that cannot do anything but
  the four calls the bot needs. Details under [Threat model](#threat-model).
- **Gateway mode.** The bot opens one outgoing WebSocket and has no URL, port or signing secret. It
  reconnects with backoff, resumes from the last event number, answers `deferred` itself when a
  handler is slow, and finishes with a REST follow-up.

```
 Harmony ◄── ws + REST (Bot token) ──┐
 (integrations ingress)              │
                                     │      ┌──────────── private network ───────────┐
                                  homelab-bot ── HTTP ──► docker-socket-proxy ──► /var/run/docker.sock (read-only mount)
                                     │      └────────────────────────────────────────┘
                                     └──── HTTP ──► Pterodactyl panel (client API key)
                                     └──── HTTP ──► Uptime Kuma public status page (optional)
```

## Set it up

1. **Create the bot** in Harmony (Server settings, Integrations, or `POST /api/bots`) with the scopes
   `messages.write`, `commands`, `panels.write`, `channels.read`, and `events`, and **no** interactions
   or events URL, which is what makes it a gateway bot. `events` is only there so the bot can send
   `resume`, which it also uses as a keepalive probe; it subscribes to no event type. Copy the token
   (shown once) into the environment as `HARMONY_BOT_TOKEN`. Add the bot to your server.
2. **Make two channels:** one of type **Dashboard** (the panels go there) and one text channel for the
   ops log. The bot needs to see both (it is a normal member, so check any channel overwrites).
3. **Give the people who may press the buttons a role** that holds the permission in
   `rolePermission` (default `manage_guild`; any [permission key](../../docs/permissions.md#permission-keys)
   works, including a module's). The server owner and holders of `administrator` always pass.
4. **Write `config.yml`** from [`config.example.yml`](config.example.yml): the two container lists and
   the URLs. Keep the real one out of git (the repository's `.gitignore` already covers
   `examples/homelab-bot/config.yml`).
5. **Generate the proxy's name lists** from the same file, then start the proxy and the bot
   (below).

### Configuration

Environment variables win over the file. Secrets only ever come from the environment.

| Variable                                        | Meaning                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `HARMONY_URL`                                   | The integrations ingress, such as `http://harmony-integrations:8081` (never the user proxy)  |
| `HARMONY_BOT_TOKEN`                             | `hb_<id>_<secret>`; environment only                                                         |
| `HARMONY_GUILD_ID`                              | Optional when the bot is in exactly one server                                               |
| `DASHBOARD_CHANNEL`                             | Id or name of the Dashboard channel                                                          |
| `OPS_CHANNEL`                                   | Id or name of the audit channel (optional, but you want it)                                  |
| `ROLE_PERMISSION`                               | Permission key needed for control buttons and control commands (default `manage_guild`)      |
| `STATUS_PERMISSION`                             | Optional key needed for `/status` and `/games`                                               |
| `DOCKER_PROXY_URL`                              | The socket proxy, such as `http://homelab-docker-proxy:2375`                                 |
| `PTERODACTYL_URL`, `PTERODACTYL_CLIENT_API_KEY` | Panel base URL and an account (client) API key; the key is environment only                  |
| `KUMA_STATUS_URL`, `KUMA_STATUS_SLUG`           | A public status page such as `http://kuma:3001/status/home`; the slug only if not in the URL |
| `REFRESH_SECONDS`, `COOLDOWN_SECONDS`           | Panel refresh interval and per-target pause after an action (30 and 30)                      |
| `HARMONY_SEQ_FILE`                              | Optional file holding the last handled event number                                          |
| `CONFIG_FILE`                                   | Path of the YAML or JSON file (default `./config.yml`)                                       |

In the file, `docker.control` lists the containers the bot may start, stop and restart,
`docker.status` the ones it only shows, and `pterodactyl.allow` optionally narrows the game servers
to some slugs. A container in neither list does not exist as far as the bot is concerned: it is not
shown, not resolved by a command and not controlled. A name in both lists is a configuration error.

### Run it

The bot needs a Docker socket proxy. This directory ships the rules for one
([`proxy/haproxy.cfg.template`](proxy/haproxy.cfg.template), explained below) and a Dockerfile for the
bot (Node 24 on Alpine, pinned by digest, runs as the unprivileged `node` user, no build step because
Node runs the TypeScript directly).

```sh
node proxy/gen-acl.ts config.yml proxy/acl     # writes proxy/acl/control.txt and visible.txt
docker build -t harmony-homelab-bot .
```

A Compose file for the two services looks like this (adapt the networks to yours):

```yaml
services:
  homelab-docker-proxy:
    image: tecnativa/docker-socket-proxy:v0.4.1
    read_only: true
    tmpfs: [/run, /tmp]
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./proxy/haproxy.cfg.template:/usr/local/etc/haproxy/haproxy.cfg.template:ro
      - ./proxy/acl:/usr/local/etc/haproxy/acl:ro
    networks: [docker-api]

  homelab-bot:
    image: harmony-homelab-bot
    read_only: true
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    env_file: ./secrets.env # HARMONY_BOT_TOKEN, PTERODACTYL_CLIENT_API_KEY
    environment:
      CONFIG_FILE: /config/config.yml
    volumes: ['./config.yml:/config/config.yml:ro']
    networks: [docker-api, harmony] # harmony: a network the integrations ingress is also on

networks:
  docker-api: { internal: true } # only the proxy and the bot; nothing is published
  harmony: { external: true }
```

Reaching Harmony from another Compose project is described in
[Integration ingress](../../docs/integrations.md#reaching-it). Without Docker, `pnpm --filter
@harmony/example-homelab-bot start` runs the bot from a checkout.

If the bot starts before Harmony or the channels exist it logs why and retries with a growing delay
instead of exiting.

## Threat model

The bot can restart your services, so the question is what an attacker gets if the bot, a chat
account or the bot's token is compromised. The design keeps that small.

**Who can do what**

- Only people holding `rolePermission` can use control buttons or commands. Harmony checks the
  button's `requiredPermission` on every press (the buttons carry it), and the bot checks the same
  rule again from the server's roles, because slash commands are not gated by key at all. The check
  fails closed: an unknown person, a failed lookup or a missing key is a refusal. An instance admin
  who holds no role in the server is not recognised; give them a role.
- Every control request is resolved against the allowlist inside the bot. A button id is only a
  lookup key: an id that was not produced for a controllable target (a forged one, a stale one, one
  for a status-only container) finds nothing, and Harmony would not deliver it anyway because it
  rejects ids that are not on the current panel (`404 unknown_action`).
- `start`, `stop` and `restart` are the only verbs that exist. There is no `kill`, `exec`, `rm` or
  `create` in the bot, and none in the proxy (below).
- Buttons ask for confirmation. Each target has a cooldown (30 s by default), set when an action is
  accepted and released if it fails, so a double click or a retry loop cannot hammer a service.
- Every action, refusal and failure is posted to the ops channel (`Ada restarted \`jellyfin\``).
  Names are stripped of markup and mentions first. Errors are reported to the person ephemerally
  with the reason, never with an address or a response body.

**What the Docker proxy allows** (verified against a real daemon by `tests/integration/proxy.test.ts`)

The stock `tecnativa/docker-socket-proxy` cannot express "list, inspect, start, stop, restart and
nothing else": `CONTAINERS=1` with `POST=1` also lets a client create, delete, exec into, pause and
kill containers, and `ALLOW_RESTARTS=1` includes `kill`. So this example keeps the image (pinned to
`v0.4.1`) and replaces its HAProxy rules with [its own](proxy/haproxy.cfg.template), which allow
exactly:

| Request                                        | Allowed when                                                 |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `GET /containers/json`                         | always (the list; the bot drops everything not on its lists) |
| `GET /containers/<name>/json`                  | `<name>` is in `visible.txt` (control and status containers) |
| `POST /containers/<name>/start\|stop\|restart` | `<name>` is in `control.txt`                                 |

Everything else is `403`: create, delete, exec, kill, pause, rename, update, attach, logs, archive
and export, the whole image, volume, network, swarm, secret, plugin, build, system, events and
version APIs, any other method on those paths, an API version prefix, a container **id** instead of
a name, and names that are not on the lists (a status-only container cannot be restarted even by
a client that talks to the proxy directly). HAProxy resolves dot segments before its rules run, so a
path such as `/containers/allowed/../other/restart` is judged as `/containers/other/restart`. The
test suite tries each of these against throwaway containers.

What the proxy does **not** hide: `GET /containers/json` returns, for every container on the host,
its name, image, labels, ports and mounts (not environment variables). A compromised bot could read
that. Inspect, which does contain environment variables, is limited to listed names.

The socket is mounted read-only into the proxy. That flag does not stop writes through an already
open socket, so the protection is the rule set, not the mount. The proxy runs read-only with no
capabilities and publishes no ports; it sits on an `internal` network shared only with the bot.

**Secrets**

- The Harmony token and the Pterodactyl key are environment only, never in the config file. Every log
  line passes through a redactor that masks both, and the proxy and panel addresses, and nothing
  in a chat message, ephemeral answer or panel contains them. Unit tests assert that for panels,
  messages, follow-ups and logs.
- Use a Pterodactyl **client** API key from an account that owns only the servers you want
  controlled. The bot sends nothing but `start`, `stop` and `restart` power signals.
- The bot token is a bot, not a person: through the ingress it cannot act as a human, and its scopes
  are the five listed above.

**Not defended against:** someone who can already run Docker commands on the host; a Harmony
administrator who can edit the bot's scopes or the roles that hold `rolePermission`; Uptime Kuma or
Pterodactyl data being wrong (the bot shows what they say).

## How it works

| File                                       | Role                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| [`src/config.ts`](src/config.ts)           | Loads YAML or JSON plus environment, validates, builds the redactor                 |
| [`src/docker.ts`](src/docker.ts)           | The four proxy calls; refuses anything outside the lists a second time              |
| [`src/pterodactyl.ts`](src/pterodactyl.ts) | List, resources, power (`start`, `stop`, `restart` only)                            |
| [`src/kuma.ts`](src/kuma.ts)               | Public status page and heartbeats                                                   |
| [`src/targets.ts`](src/targets.ts)         | The registry (allowlisted containers and game servers), slugs, button ids, cooldown |
| [`src/panels.ts`](src/panels.ts)           | Pure builders for the panels, inside the panel API limits                           |
| [`src/permissions.ts`](src/permissions.ts) | Permission check from roles (cached for 10 s)                                       |
| [`src/harmony.ts`](src/harmony.ts)         | REST client, gateway client with reconnect, resume and the answer deadline          |
| [`src/bot.ts`](src/bot.ts)                 | Start-up, refresh loop, interaction handling, audit log                             |

- **Panels.** `containers` has two stats and status lists for the managed and the monitored
  containers, then the buttons; a stopped container offers Start, a running one Restart and Stop.
  Buttons sit in `actions` blocks of at most five (the API limit), packed by container. When a long
  list needs more than 24 blocks the rest goes to `containers-2` and so on, which are removed again
  when no longer needed. `games` and `monitors` follow the same pattern. If a backend does not answer,
  its panel says so instead of showing old data. The bot owns the panels it publishes, so
  it deletes its own leftovers only.
- **Refresh.** A timer rewrites the panels every `refreshSeconds`. It is separate from the
  interaction handling, so a later `refresh` button answered with `update_panel`, or a scheduler
  that pokes the bot, could reuse `HomelabBot.refresh()` without changes.
- **Slow work.** Anything that talks to Docker or Pterodactyl answers `deferred` first and finishes
  with an ephemeral follow-up; the gateway client also defers by itself if a handler is still busy
  after 2.2 s, well inside the server's 3 s deadline.
- **Game server targets.** Pterodactyl server names are slugified (`Core Keeper` becomes
  `core_keeper`). Two servers with the same slug are not offered at all, and a container and a game
  server with the same name need a `game:` or `docker:` prefix.
- **Players.** The Pterodactyl client API does not report who is online, so the game panel shows
  state, CPU, memory and uptime only.

## Tests

```sh
pnpm --filter @harmony/example-homelab-bot test:unit         # also part of pnpm test:unit
pnpm --filter @harmony/example-homelab-bot test:integration  # needs Docker: real proxy, real daemon, throwaway containers
pnpm --filter @harmony/example-homelab-bot test:stack        # needs a Harmony dev server, see below
```

The unit tests cover allowlist enforcement (forged, stale and status-only button ids, names that
try to escape), target resolution, the cooldown, panels against the panel schema, error mapping,
the gateway client with a fake socket, the permission rule, and that secrets never appear in
panels, messages or logs. The integration test starts three `sleep` containers and a proxy with the
shipped rules and checks the table above. The stack test brings the bot up in gateway mode against a
Harmony dev server (`compose.dev.yml`, the API on `18080` with `NODE_ENV=development` and
`DEV_AUTH_LOGIN=dev@example.com`, an empty database so the first person is the instance admin),
with a mock game panel: it registers commands, publishes panels, has a person press Restart on a
throwaway container, checks the ops line, and checks that a member without the permission and
ids outside the lists get nowhere. Tests only ever touch containers they created themselves.
