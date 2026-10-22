# Uptime Kuma notifications in Harmony

Harmony's incoming webhooks accept Discord's webhook payload, so Uptime Kuma's built-in **Discord** notification type works unchanged.

## Verified against Uptime Kuma's source

The payload below was checked against `server/notification-providers/discord.js` on the `master` branch of louislam/uptime-kuma (October 2026), and each shape is covered by an integration test (`apps/server/tests/integration/webhooks.test.ts`, fixtures in `apps/server/tests/support/kuma-payloads.ts`).

- Down and up alerts are `{username, embeds: [{title, color, timestamp, fields: [{name, value}, ...]}]}`, with `content` only when a prefix message is configured. Harmony ignores the extra keys Kuma sometimes adds (`avatar_url` is honored; `flags` and `thread_name` are ignored).
- `timestamp` is `heartbeatJSON.time`, which is `YYYY-MM-DD HH:mm:ss.SSS` in UTC, **not** ISO 8601. Harmony accepts it and stores it as ISO 8601.
- Field values can be empty or `N/A`; Harmony accepts both.
- The "Test" button and the minimalist and custom-template formats send plain `{username, content}`.
- Before posting, Kuma does a `GET` on the webhook URL to see whether the webhook has an avatar and ignores any failure. Harmony does not answer `GET` on webhook URLs (it returns 404), which Kuma treats as "has an avatar".
- A mass-ping prefix such as `@everyone` is defused by Harmony.

## Set it up

1. Create a webhook for the channel (guild owner or instance admin):

   ```sh
   curl -H 'Tailscale-User-Login: you@example.com' -H "Origin: $PUBLIC_ORIGIN" \
        -H 'Content-Type: application/json' -X POST \
        http://127.0.0.1:8470/api/channels/<channel id>/webhooks -d '{"name": "Uptime Kuma"}'
   ```

   The response contains `url` (`/api/webhooks/<id>/<token>`), shown only once.

2. In Uptime Kuma: **Settings > Notifications > Setup Notification**, type **Discord**, and set **Webhook URL** to the integration ingress plus that path. How Kuma reaches the ingress depends on where it runs (see [docs/integrations.md](../docs/integrations.md)):
   - Kuma in Docker on the same host: attach the `integrations` service to Kuma's network with `docker-compose.override.yml`, then use `http://harmony-integrations:8081/api/webhooks/<id>/<token>`.
   - Kuma elsewhere: anything that can reach the ingress port, or the public Harmony URL (`https://chat.example.ts.net:18470/api/webhooks/<id>/<token>`) from a tailnet device.

3. Press **Test**. A message from "Uptime Kuma" should appear in the channel. Attach the notification to your monitors.

Webhooks are limited to 30 requests per minute each; the server answers `429` with `Retry-After` beyond that.
