# Integration ingress

People reach Harmony through Tailscale Serve and the user proxy, which is the only
component holding the proxy secret. Machines (incoming webhooks, interaction follow-ups
and bots with `Authorization: Bot` tokens) have a second, separate way in: the
`integrations` container.

```
 tailnet browser ── Tailscale Serve ── nginx (user proxy, adds secret) ──┐
                                                                         ├── app
 scripts on the host ── 127.0.0.1:8471 ──┐                               │
 containers on attached networks ────────┴── integrations (no secret) ───┘
```

## What the integrations proxy allows

- `POST /api/webhooks/:id/:token` and `POST /api/interactions/:id/:token/followup`:
  the token in the path is the credential.
- Any `/api/*` request (including the `/api/ws` gateway) that carries `Authorization: Bot <token>`.
- Everything else gets 404.

It blanks every `Tailscale-*` identity header and the proxy-secret header before
proxying, and the container never receives the secret at all. A request arriving here
can therefore only ever act as a bot or a webhook, never as a person, even if the
network it sits on is shared with untrusted containers.

## Reaching it

| Caller                                                | Address                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Script or cron job on the host                        | `http://127.0.0.1:8471`                                                                                |
| Container in another Compose project on the same host | attach the ingress to that project's network (below), then `http://harmony-integrations:8081`          |
| Device on the tailnet                                 | the public URL, e.g. `https://chat.example.ts.net:18470` (webhook paths and bot tokens work there too) |

Attaching to another project's network only changes Harmony's own container. Copy
`docker-compose.override.example.yml` to `docker-compose.override.yml` (gitignored, as
network names are deployment details), set the external network name, and run
`docker compose up -d`.

Host firewalls often drop traffic from containers to ports published on the host, which
is why attaching to the network is the recommended route for containers, rather than
`host.docker.internal:8471`.

## Agents (MCP)

[`packages/mcp`](../packages/mcp/README.md) is a Model Context Protocol server that gives an
agent (Claude Code, Claude Desktop, any MCP client) tools to read channels, post, ask a person
a question and wait for the answer. It is one more bot client of this ingress: set
`HARMONY_URL=http://127.0.0.1:8471` and `HARMONY_BOT_TOKEN` to the bot's token, and it uses
the same `Authorization: Bot` REST calls and `/api/ws` gateway described above. It has no
access beyond the bot's scopes and memberships. Setup, scopes per tool and the safety notes
(chat is untrusted input, rate limit, mass mentions) are in its README.
