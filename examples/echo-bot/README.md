# Echo bot

A single-file bot (`bot.ts`, about 80 lines) that shows the whole integration loop: it registers two slash commands, verifies the signature on every request, answers `/echo` with an ephemeral message, answers `/roll` with a deferred reply plus a follow-up, and logs the events it receives.

## Set it up

All of these use your own identity, so run them from the host that serves Harmony (the proxied listener is `127.0.0.1:8470`; `PUBLIC_ORIGIN` is the value from your `.env`).

```sh
H='-H Tailscale-User-Login:you@example.com -H Content-Type:application/json'
O="-H Origin:$PUBLIC_ORIGIN"
API=http://127.0.0.1:8470

# 1. Create the bot. The response contains `token` and `signingSecret`; they are shown only once.
curl $H $O -X POST $API/api/bots -d '{
  "name": "Echo",
  "scopes": ["messages.read", "messages.write", "commands", "events"],
  "interactionsUrl": "http://echo-bot:4000/interactions",
  "eventsUrl": "http://echo-bot:4000/events",
  "eventTypes": ["message.created", "guild.member_joined"]
}'

# 2. Add it to a guild you own.
curl $H $O -X POST $API/api/guilds/$GUILD_ID/bots -d '{"botId": "<bot id>"}'
```

The bot's URLs point at a private address, which the server only accepts when the bot's owner is an instance admin **and** the host is listed in `OUTBOUND_PRIVATE_ALLOWLIST` (for the URLs above: `OUTBOUND_PRIVATE_ALLOWLIST=echo-bot` in `.env`, then recreate `app` and `worker`). Without that, saving the URLs fails with `url_not_allowed`.

## Run it

Either run it as a container on the `harmony_internal` network under the name `echo-bot`, or run it on the host and use the host's address in the URLs and in the allowlist (check that your firewall lets containers reach it).

```sh
HARMONY_URL=http://127.0.0.1:8471 \
HARMONY_BOT_TOKEN=hb_... HARMONY_SIGNING_SECRET=hsk_... HARMONY_GUILD_ID=... \
pnpm --filter @harmony/example-echo-bot start
```

`127.0.0.1:8471` is the integration ingress: it only forwards bot-token requests, webhooks and interaction follow-ups. Then type `/echo text:hi` or `/roll sides:20` in a channel of that guild (the web client lists commands from `GET /api/guilds/:id/commands`).

## Demo dashboard

Add the `panels.write` scope to the bot, make a channel of type **Dashboard**, and set `HARMONY_DASHBOARD_CHANNEL_ID` (and optionally `HARMONY_PANEL_INTERVAL_MS`, default 5000). The bot then publishes a "Demo host" panel with made-up numbers: two stats, a live area chart it appends points to, a status list, a progress bar and two buttons. **Refresh** is answered with `update_panel`; **Restart service** has a confirm dialog, needs `manage_messages`, and is answered with an ephemeral message.

## Scheduled refresh

With a dashboard channel set, the bot also registers a schedule with `PUT /api/bots/@me/schedules` (needs the `commands` scope it already has): `every: 60` seconds, `panelKey: "host"`. Harmony then sends a `refresh` interaction once a minute and the bot answers with `update_panel`, in HTTP and gateway mode alike. `HARMONY_REFRESH_SECONDS` changes the period (the server refuses less than 60 unless `SCHEDULE_MIN_EVERY_SECONDS` is lowered). Managers see the schedule, and can pause it, under Channel settings > Bots.

## Gateway mode (no URL)

The same bot can run with nothing reachable: create it **without** `interactionsUrl` and `eventsUrl` (keep the `commands` scope; add `events` and `eventTypes` if you want events), then

```sh
HARMONY_MODE=gateway HARMONY_URL=http://127.0.0.1:8471 \
HARMONY_BOT_TOKEN=hb_... HARMONY_GUILD_ID=... \
pnpm --filter @harmony/example-echo-bot start
```

It opens a WebSocket to `/api/ws`, sends `resume`, answers `/echo`, `/roll` and the dashboard buttons with `interaction.respond`, and acknowledges events. No signing secret, port or allowlist entry is needed. Set `HARMONY_SEQ_FILE` to keep the last handled event number across restarts. See [Building a gateway bot](../../docs/integrations.md#building-a-gateway-bot).
