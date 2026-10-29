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

## Building a gateway bot

A bot that runs on a laptop, behind NAT or in a container nobody can dial does not need any URL.
Leave `interactionsUrl` and `eventsUrl` empty, give it the `commands` and/or `events` scopes (and
`eventTypes` for events) and let it connect out:

1. Open `ws(s)://<host>/api/ws` with the header `Authorization: Bot <token>`. Use the ingress
   (`127.0.0.1:8471`, or the public URL from a tailnet device) for the `/api/ws` path; it only forwards
   requests that carry a bot token. Wait for `hello`.
2. Send `resume {lastSeq}` with the highest event `seq` you have handled (0 the first time).
3. On `interaction.create`, answer with `interaction.respond` inside the deadline (3 s by default).
   For slow work answer `{type: "deferred"}` and use the REST follow-up with the interaction `token`.
4. On `event`, handle it, remember `seq`, send `event.ack {seq}`. Skip a `seq` you already handled.
5. When the socket closes, reconnect with backoff and go back to step 1. Keep the last handled `seq`
   somewhere durable if events must survive a restart of the bot.

[`examples/echo-bot`](../examples/echo-bot/bot.ts) does exactly this with `HARMONY_MODE=gateway` (and
no `HARMONY_SIGNING_SECRET`, no `PORT`), including the demo dashboard button. The frames, resume
semantics and limits are in [the protocol](api/protocol.md#gateway-bots-no-url).

What changes compared with HTTP: nothing needs to be reachable, so there is no
`OUTBOUND_PRIVATE_ALLOWLIST` entry to maintain and no signature to verify (the socket is
authenticated by the bot token); in exchange the bot must be connected when an interaction happens,
or the user sees `interaction.failed` (`unreachable`) immediately. Events are not lost while it is
away, within the retention limits above. Follow-ups, panels and messages still use the REST API, so
the bot must reach Harmony over HTTP as well.

## Panels and buttons

Bots can publish dashboards: panels of stats, charts, tables and buttons that Harmony renders
natively. Give the bot the `panels.write` scope (and `commands` plus an interactions URL if it has
buttons), add it to the server, and make a channel of type **Dashboard** (or pin a panel in a text
channel). The full reference is in the [protocol](api/protocol.md#panels-and-buttons); the
[echo bot](../examples/echo-bot/README.md) publishes a working demo.

```sh
curl -X PUT $API/api/channels/$CHANNEL_ID/panels/host \
  -H "Authorization: Bot $TOKEN" -H 'Content-Type: application/json' -d '{
  "pinned": false,
  "view": {
    "title": "Host",
    "blocks": [
      { "type": "stat", "label": "CPU", "value": 41, "unit": "%", "tone": "good" },
      { "type": "stat", "label": "Memory", "value": "6.1", "unit": "GB", "delta": "+0.2" },
      { "type": "chart", "id": "load", "kind": "line", "span": "full", "yUnit": "%",
        "series": [{ "name": "cpu", "points": [{ "x": "2026-10-29T10:00:00Z", "y": 38 }] }] },
      { "type": "status", "items": [{ "label": "Database", "state": "ok" }] },
      { "type": "actions", "buttons": [
        { "id": "restart", "label": "Restart", "style": "danger",
          "confirm": { "title": "Restart the service?" },
          "requiredPermission": "manage_messages" } ] }
    ]
  }
}'

# Stream new points instead of resending the view (the newest 500 per series are kept):
curl -X POST $API/api/channels/$CHANNEL_ID/panels/host/points \
  -H "Authorization: Bot $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "blockId": "load", "series": "cpu", "points": [{ "x": "2026-10-29T10:00:05Z", "y": 44 }] }'
```

Blocks: `stat` (label, value, unit, delta, tone), `chart` (`line`, `bar` or `area`; up to 8 series of
500 points; x is a number or an ISO time), `table` (up to 8 columns and 100 rows), `status` (up to
50 items: `ok`, `warn`, `bad`, `unknown`, `off`), `progress`, `kv` (up to 30 pairs), `markdown`
(the same safe subset as messages, up to 4000 characters) and `actions` (up to 5 buttons). Without a
`span`, stats and progress bars take half the width and the other blocks the full width; the grid
has two columns when the card is at least 720 px wide and one below that.

Pressing a button calls the bot's interactions URL with a signed `type: "action"` payload (see the
protocol). Answer within 3 seconds with a message, `deferred`, or `update_panel`:

```json
{ "type": "update_panel", "view": { "blocks": [{ "type": "stat", "label": "CPU", "value": 12 }] } }
```

The same buttons work under a message: add `"components": { "buttons": [ … ] }` to a message the
bot sends.

## Agents (MCP)

[`packages/mcp`](../packages/mcp/README.md) is a Model Context Protocol server that gives an
agent (Claude Code, Claude Desktop, any MCP client) tools to read channels, post, ask a person
a question and wait for the answer. It is one more bot client of this ingress: set
`HARMONY_URL=http://127.0.0.1:8471` and `HARMONY_BOT_TOKEN` to the bot's token, and it uses
the same `Authorization: Bot` REST calls and `/api/ws` gateway described above. It has no
access beyond the bot's scopes and memberships. Setup, scopes per tool and the safety notes
(chat is untrusted input, rate limit, mass mentions) are in its README.
