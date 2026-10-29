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

## Webhook presets and templates

A webhook has a **format** that decides how an incoming body becomes a message. Change it with the
pencil button on the webhook in **Server settings, Integrations**, which also has a sample box and a
live preview, so you can see what a payload will look like before the service sends one.

| Format                    | Use it for                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `discord` (default)       | Senders that already speak Discord webhooks, such as Uptime Kuma's Discord notification |
| `forgejo`, `github`       | Push, pull request, issue, comment, review, release and workflow or Actions run events  |
| `alertmanager`, `grafana` | Firing and resolved alert groups                                                        |
| `watchtower`              | Container update notifications (JSON or plain text)                                     |
| `generic`                 | Any JSON: well-known keys become the title, text and link, the rest become fields       |
| `template`                | Any JSON, mapped by a template you write (below)                                        |

Presets answer `204` for events they choose to ignore (for example GitHub's `check_run`, label
changes, or `created` releases that are followed by `published`), so a noisy sender does not fill the
channel. Nothing is posted and nothing counts against the limits except the rate limit.

### Setting up each service

Create the webhook, pick the format, then paste its URL (`<webhook URL>` below, shown once when the
webhook is created; use the address your sender can reach, see [Reaching it](#reaching-it)).

- **Forgejo or Gitea.** Repository, Settings, Webhooks, Add webhook, type **Gitea** (or
  **Forgejo**). Target URL `<webhook URL>`, content type `application/json`. Choose the events you
  want: push, pull request, issues, issue comment, release, and on Forgejo the Actions run events.
  Optionally set a **Secret** here and the same value under _Signing secret_ in Harmony; see
  [Signatures](#signatures). **Test delivery** sends a sample push, which shows up as a normal push message.
- **GitHub.** Repository, Settings, Webhooks, Add webhook. Payload URL `<webhook URL>`, content type
  `application/json` (the form-encoded type also works). Pick individual events. Optional secret as
  above. GitHub's first `ping` shows as "Webhook connected".
- **Prometheus Alertmanager.** Add a receiver and route to it:

  ```yaml
  receivers:
    - name: harmony
      webhook_configs:
        - url: <webhook URL>
          send_resolved: true
  ```

  One message per notification group, with up to eight alerts listed, colored by severity and green
  when resolved.

- **Grafana.** Alerting, Contact points, New, integration **Webhook**, URL `<webhook URL>`, method
  POST. Unified alerting bodies (with an `alerts` array) use Grafana's own title and message and add
  dashboard and silence links; the older single-alert body is understood too.
- **Watchtower.** Point its shoutrrr notification at the generic service, for example
  `WATCHTOWER_NOTIFICATION_URL=generic+<webhook URL>?template=json` (or without `template=json` for
  a plain text body). The preset accepts `{message, title}`, plain text, and a report-shaped body
  with `report` and `entries`.
- **Home Assistant, cron jobs and anything else.** Use `generic`, or a template to choose exactly
  what is shown. Home Assistant's `rest_command` can send any JSON.

### Templates

A template is a small JSON document, not code. Strings may contain `{{path | filter}}`
placeholders that are looked up in the JSON body the service sent:

```json
{
  "content": "Backup {{status | upper}} on {{host.name}}",
  "embed": {
    "title": "{{name}}",
    "description": "{{message | default:\"No details\"}}",
    "url": "{{link}}",
    "color": "#2ecc71",
    "fields": [{ "name": "Host", "value": "{{host.name}}", "inline": true }],
    "footer": "{{finished_at}}"
  }
}
```

- **Paths** are dot separated with array indices: `host.disks[0].label` or `host.disks.0.label`. A
  path that does not exist, or points at `null`, renders as empty. Objects and arrays render as
  compact JSON. Names such as `__proto__`, `constructor` and `prototype` are refused when the
  template is saved, and only the body's own properties are ever read.
- **Filters** are exactly `upper`, `lower`, `truncate:N`, `default:"text"` and `json`, chained with
  `|`. There are no loops, conditions, expressions or functions.
- `color` is a number or text that renders to `#rrggbb` or a decimal number. A `url` that does not
  render to an `http(s)` address is dropped. A field whose name renders empty is dropped. If
  nothing is left to post, the webhook answers `204`.
- Limits: 2000 characters per string (embed fields use the embed limits), 10 fields, 100
  placeholders per template. The result is clamped to the usual embed limits, and `@everyone` and
  `@here` are defused wherever they came from.
- A template is validated when it is saved. `POST /api/webhooks/:id/preview` renders a sample
  without posting anything; see the [protocol](api/protocol.md#webhook-formats-and-templates).

### Signatures

For `github` and `forgejo` you can set a secret. Harmony then computes the HMAC-SHA256 of the raw
request body and compares it, in constant time, with `X-Hub-Signature-256` (GitHub, and also sent
by Forgejo) or `X-Forgejo-Signature` / `X-Gitea-Signature`. A missing or wrong signature is
`401 invalid_signature` and nothing is posted. The secret is the same string you typed into the
sender. The path token is still required: the signature adds proof that the body was not changed
and came from a sender that knows the secret, which matters if a webhook URL leaks into a log.

Other formats cannot be signed, and the settings screen only offers a secret where it works.

Not supported (left out on purpose): panel targets, where a webhook drives a dashboard panel.
Panels belong to a bot that is a member of the channel, and a webhook's author is not; see the
decision in `NOTES.md`.

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

## Bot channels

A guild manager (the channel's creator or anyone with `manage_channels`) can assign bots to a
channel from **Channel settings > Bots**, or with `PUT /api/channels/:id/bots`. The channel header
then shows the assigned bots and `/` autocomplete in that channel lists their commands first.
Assignment is a hint for clients and grants a bot nothing: it can still only do what its scopes and
the channel's permissions allow, and it must already be a member of the guild.

The same tab has **Bot feed**, for channels that carry alerts, status or digests and should stay
readable. With feed mode on, only bots, incoming webhooks and people with `manage_messages` in the
channel can post. Everyone else sees a locked composer, can still react, press panel and message
buttons and run `/` commands, and gets `403 bot_feed` from the API if they try to post anyway.
Pinned panels sit above the messages as usual, so a feed channel with an assigned bot, a pinned
dashboard and the bot's posts is a complete status page. See the
[protocol](api/protocol.md#patch-apichannelsid) for the endpoints.

## Scheduling refreshes

A bot that keeps a dashboard fresh does not need its own timer: it registers a schedule and Harmony
asks it when the time comes. The `commands` scope is enough (the schedule is delivered like a
command, so a bot with no URL gets it on its gateway connection).

```sh
curl -X PUT $API/api/bots/@me/schedules \
  -H "Authorization: Bot $TOKEN" -H 'Content-Type: application/json' -d '{
  "schedules": [
    { "id": "host-panel", "channelId": "'$CHANNEL_ID'", "every": 60, "panelKey": "host" },
    { "id": "weekly-digest", "channelId": "'$CHANNEL_ID'", "cron": "0 9 * * 1" }
  ]
}'
```

`every` is 60 to 86400 seconds; `cron` has five fields (minute, hour, day of month, month, day of
week) in **UTC**, with numbers, `*`, lists, ranges and `/` steps (no names or `@` macros; when both
day fields are restricted either may match, as in cron). Register on every start: the call replaces
the bot's whole list, a schedule that keeps its cadence keeps its place in time, and a pause set by a
manager survives it. At most 20 schedules per bot per guild.

When one is due the bot receives a `refresh` interaction (same signature, same 3 second deadline,
no `user`):

```json
{ "type": "refresh", "schedule": { "id": "host-panel", "channelId": "11", "panelKey": "host" }, "id": "9", "token": "…", … }
```

Answer `{"type": "update_panel", "view": …}` to replace the panel named by `panelKey`,
`{"type": "message", …}` to post, or `{"type": "deferred"}` and update the panel yourself with the
panel API. The [echo bot](../examples/echo-bot/README.md) does the first in both HTTP and gateway
mode.

What to expect: runs are at most once per period even with two app instances; if the bot is still
answering the previous run when the next falls due, that one is skipped; runs missed while the
server was down are not replayed; jitter moves each run by up to 10 percent of the period (5 s at
most). Managers see each schedule, its next run and its last result under **Channel settings >
Bots**, and can pause, resume or delete it. Removing the bot from the guild deletes its schedules.
Details and error codes: [protocol](api/protocol.md#scheduled-refreshes).

## Agents (MCP)

[`packages/mcp`](../packages/mcp/README.md) is a Model Context Protocol server that gives an
agent (Claude Code, Claude Desktop, any MCP client) tools to read channels, post, ask a person
a question and wait for the answer. It is one more bot client of this ingress: set
`HARMONY_URL=http://127.0.0.1:8471` and `HARMONY_BOT_TOKEN` to the bot's token, and it uses
the same `Authorization: Bot` REST calls and `/api/ws` gateway described above. It has no
access beyond the bot's scopes and memberships. Setup, scopes per tool and the safety notes
(chat is untrusted input, rate limit, mass mentions) are in its README.
