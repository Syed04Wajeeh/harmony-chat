# Trust model: authentication via Tailscale identity

Harmony has no passwords and no login page. A person is whoever their Tailscale
identity says they are. This document explains why that is safe, what it depends
on, and where it would break.

## Request path

```
browser ──HTTPS──► Tailscale Serve (on the host, :18470)
                      │  deletes any client-sent Tailscale-* identity headers
                      │  looks up the peer with WhoIs, sets identity headers
                      ▼
               127.0.0.1:8470  (published on loopback only)
                      ▼
                    nginx   adds X-Harmony-Proxy-Secret
                      ▼
                  app:8080  (no published port; docker network only)
```

## What Tailscale Serve guarantees

Verified against the Tailscale source (`ipn/ipnlocal/serve.go`,
`addTailscaleIdentityHeaders`, v1.102.3) and by sending forged headers through a
live Serve endpoint:

- Serve **always deletes** incoming `Tailscale-User-Login`, `Tailscale-User-Name`,
  `Tailscale-User-Profile-Pic`, `Tailscale-Funnel-Request` and
  `Tailscale-Headers-Info` before proxying. A forged
  `Tailscale-User-Login: attacker@example.com` sent through Serve arrived at the
  backend replaced by the caller's real login.
- It then sets those headers only when `WhoIs` resolves the source address to a
  node **that is not tagged**. Tagged nodes (servers, CI runners) and traffic from
  the local machine get no identity headers at all.
- Funnel (public internet) traffic gets `Tailscale-Funnel-Request: ?1` and no
  identity.
- Display names containing non-ASCII characters are sent RFC 2047 Q-encoded
  (`=?utf-8?q?...?=`), so the app decodes them. Invalid UTF-8 becomes an empty
  string.

The identity is the Tailscale login name, which is cryptographically tied to the
WireGuard key of the device the request came from. Nobody can claim another
user's identity without that user's device key.

## What the app checks on every authenticated request

| Check                                                                                                      | Rejects                  | Why                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Harmony-Proxy-Secret` matches (constant-time compare)                                                   | `403 proxy_required`     | Only nginx knows the secret. Another container on the Docker network that talks to `app:8080` directly cannot forge identity headers. |
| `Tailscale-Funnel-Request` absent                                                                          | `403 funnel_not_allowed` | Defense in depth if Funnel is ever enabled on this port by mistake.                                                                   |
| `Tailscale-User-Login` present                                                                             | `401 no_identity`        | Tagged nodes and anything else without a user identity.                                                                               |
| Optional login allowlist                                                                                   | `403 not_allowed`        | Limits access to named people even if more users can reach the node.                                                                  |
| `Origin` equals the configured public origin, on every state-changing request and on the WebSocket upgrade | `403 bad_origin`         | See below.                                                                                                                            |

### Why the Origin check matters most

Header-based identity is **ambient**: the browser's Tailscale client attaches
the user's identity to every request that reaches Serve, no matter which web
page started it. That is the same property cookies have, so the same attacks
apply. If a tailnet user visits a malicious site, that site's JavaScript could
`fetch()` the chat API or open a WebSocket to it, and the request would arrive
fully authenticated.

- For `fetch`/form posts that is classic **CSRF**.
- For WebSockets it is **cross-site WebSocket hijacking (CSWSH)**. Browsers do
  not apply CORS to WebSocket handshakes, so the attacker could read the stream.

Browsers always send an `Origin` header on these requests and page scripts
cannot change it. The app therefore rejects any non-GET request or WebSocket
upgrade whose `Origin` is missing or differs from the chat's own origin. GET
endpoints have no side effects, and CORS stops a foreign page from reading
their responses.

## Network exposure

- nginx is published on `127.0.0.1:8470` only (and the bot ingress on `127.0.0.1:8471`, see
  below). Other tailnet peers and LAN devices cannot reach it directly; connecting to
  `<tailnet-ip>:8470` is refused. The only route in from the network is through Serve.
- The app container publishes no ports.
- Postgres and Redis publish no ports and sit on the project's own Docker network.

## What we trust (residual risk)

- **The host.** Any process on the host can connect to `127.0.0.1:8470` and send
  arbitrary identity headers, because nginx cannot tell Serve apart from another
  local process. This is the standard assumption for header-auth behind a
  reverse proxy. Anyone with code execution on the host can already read the
  database, so it adds no new capability.
- **Tailscale's control plane** to map node keys to users correctly.
- **The proxy secret** stays secret: it lives in `.env`, which is never
  committed.

## Development mode

`NODE_ENV=development` with `DEV_AUTH_LOGIN` set replaces the Tailscale identity
and the proxy secret with a fixed fake identity, so the app can run without
Serve or nginx. Two rules keep this from reaching a real deployment:

- `loadConfig` refuses to start when `DEV_AUTH_LOGIN` is set under any other
  `NODE_ENV`, and the auth policy only receives a dev identity when
  `NODE_ENV=development`.
- The `Origin` check still applies to every state-changing request and the
  WebSocket upgrade.

To let tests act as several people at once (two browser contexts, one per user),
a dev-mode server also honors a **`dev_login` cookie**, for example
`dev_login=ada@example.com`. It overrides the fixed identity for that request
only, and only when all of these hold:

- the policy is a development policy (`NODE_ENV=development` and `DEV_AUTH_LOGIN`
  set), so a production policy never reads the cookie;
- the value matches `^[a-z0-9._+-]{1,64}@example.com$` (a reserved domain, so it
  cannot impersonate a real tailnet login); anything else, including malformed
  encodings, falls back to the configured identity;
- the `ALLOWED_LOGINS` allowlist, if set, still applies to the resulting login.

Unit tests (`apps/server/tests/unit/policy.test.ts`) cover the cookie being
ignored by a proxy-secret policy, by a production config, and when malformed
or off-domain.

## Considered and rejected

- **Calling `tailscale whois` from the app** to re-verify the `X-Forwarded-For`
  address. It would need the tailscaled LocalAPI socket mounted into the
  container. That socket grants far more than read-only lookups, so it is a worse
  trade than trusting Serve's headers, which the source shows are always
  rewritten.
- **Embedding Tailscale in the app (`tsnet`)** so the app sees peer identity
  directly. It is Go-only; the Node bindings are immature.
- **Passwords or OAuth as well.** Out of scope: the point is that the network
  identity _is_ the login.

## Bots and integrations

Machine clients never use identity headers. They authenticate with their own credentials, and
those paths are deliberately separate from the human one above.

### Credentials

| Client                  | Credential                                                                             | Stored as                                                    |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Bot calling the API     | `Authorization: Bot hb_<botId>_<43 char base64url secret>`                             | SHA-256 of the secret (`bots.token_hash`)                    |
| Incoming webhook sender | The secret in the URL path `/api/webhooks/:id/:token`                                  | SHA-256 (`webhooks.token_hash`)                              |
| Bot answering a command | The interaction token in `/api/interactions/:id/:token/followup`, valid for 15 minutes | SHA-256 (`interactions.token_hash`)                          |
| Server calling a bot    | HMAC signature with the bot's signing secret (below)                                   | The signing secret itself (`bots.signing_secret`), see below |

- Secrets are 32 random bytes (256 bits), so a fast hash is enough: there is nothing to guess
  and nothing for a slow hash to slow down. Lookups go by id and compare with `timingSafeEqual`;
  an unknown id costs the same comparison against a dummy hash. Tokens are shown once, on
  creation or rotation, and rotating replaces the hash, which revokes the old token on the very
  next request (no caching of bot credentials).
- A bot's token is as powerful as the bot: it acts with exactly the guild and channel
  memberships the bot has, limited by its scopes (`messages.read`, `messages.write`,
  `reactions.write`, `channels.read`, `commands`, `events`). Endpoints that change who has
  access (guilds, invites, channels, uploads, bot management, webhooks) are human-only, and any
  route that does not declare a bot scope is closed to bots by default.
- The signing secret has to be usable to compute a MAC, so it cannot be stored hashed. It is
  kept in the database in the clear; the database already holds everything a bot can reach.

### Why `Authorization: Bot` skips the Origin check and ignores Tailscale headers

Human identity is ambient (the browser's tailnet connection adds it to anything the page does),
which is why the Origin check exists. A bot token is the opposite: it is never attached
automatically. A script in a victim's browser cannot add an `Authorization` header to a
cross-site request without a CORS preflight, and the app sends no CORS headers, so the browser
blocks that request before it is sent. There is nothing for an Origin check to protect on this
path.

For the same reason, once an `Authorization: Bot` header is present it alone decides the
request: the `Tailscale-*` headers, the proxy secret and the Origin are not read at all, and a
wrong token is `401` with no fallback to a human identity. A request that carries a valid bot
token and `Tailscale-User-Login: admin@...` acts as the bot, never as the admin. Logins under
`@bots.harmony.invalid` (the synthetic logins of bots and webhook authors) are also refused on
the human path.

The proxy-secret check is not required for bot requests, so that integrations can reach the app
through the host-local ingress below, which does not hold the secret.

### Host-local ingress

nginx has a second listener, published as `127.0.0.1:8471`, for scripts running on the host
(cron jobs, Uptime Kuma, a bot process). It forwards only `POST /api/webhooks/*`,
`POST /api/interactions/*` and requests with an `Authorization: Bot` header; every other path
and method is a 404 from nginx. It never adds `X-Harmony-Proxy-Secret` and blanks the secret
and all `Tailscale-*` headers, so nothing that arrives there can ever be authenticated as a
human even if the app were misconfigured. Like the main listener it is loopback-only; the same
residual risk applies: anything on the host can reach it, but all it can use is a credential it
already holds.

### Signed requests to bots

The server calls a bot's `interactionsUrl` (slash commands) and `eventsUrl` (outgoing events).
Each request carries

- `X-Harmony-Timestamp`: unix seconds,
- `X-Harmony-Signature`: `v1=` + hex `HMAC-SHA256(signingSecret, timestamp + "." + rawBody)`,
- for events, `X-Harmony-Delivery-Id`, stable across retries.

`verifySignature()` in `@harmony/shared/signature` recomputes the MAC over the raw bytes,
compares in constant time and rejects timestamps more than 5 minutes from now, which bounds
replay of a captured request. The timestamp is part of the signed string, so it cannot be
changed without breaking the signature. Receivers that cannot tolerate duplicates should
deduplicate on the delivery id. The signing secret is generated at bot creation, shown once and
can be rotated.

### SSRF: the server makes requests to addresses users choose

`interactionsUrl` and `eventsUrl` make the server connect to a URL supplied by a user. Left
alone, a tailnet guest could point it at the Docker network (the database, Redis), host-local
admin panels, other tailnet nodes, or a cloud metadata address, and use the bot's visible
behavior (status, delivery log) as an oracle. Every outbound request therefore goes through
`safeFetch`:

1. The URL must be `http` or `https` and carry no credentials. The WHATWG URL parser
   normalizes decimal, octal, hex and shortened IPv4 spellings (`2130706433`, `0177.0.0.1`,
   `127.1`) to dotted quads before any check, so they are classified as what they are.
2. The host is resolved **once**. Names equal to `localhost` or ending in `.localhost` are
   treated as loopback without consulting DNS.
3. Every resolved address must be public. Refused: `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT,
   which contains the tailnet addresses), `127/8`, `169.254/16` (including `169.254.169.254`),
   `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, the documentation ranges, multicast,
   `240/4`; for IPv6 everything outside global unicast `2000::/3` (so `::`, `::1`, `fc00::/7`,
   `fe80::/10`, `ff00::/8`) plus `2001::/23` and documentation space. IPv4-mapped (`::ffff:a.b.c.d`),
   NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses are unwrapped and the embedded IPv4
   address is classified. If any answer is private the request is refused, not filtered.
4. The socket is opened to the vetted address through a custom `lookup` on the undici agent,
   so a name that resolves differently a moment later (DNS rebinding) cannot change the
   destination. TLS still validates the certificate against the original hostname.
5. Redirects are never followed, the response body is cut off at 64 KiB, and the request has a
   hard deadline (3 s for interactions, 5 s for events).

The check runs when a URL is saved (so a mistake is reported immediately, as `400
url_not_allowed`) **and again on every request**, because DNS can change after saving.

The one exception is homelab integrations that really do live on private addresses. A bot whose
owner is an instance admin may reach a private destination only if the host matches
`OUTBOUND_PRIVATE_ALLOWLIST` (comma-separated hostnames, IPs or CIDRs; empty by default). A
hostname entry matches that host name; an IP or CIDR entry must contain every address the name
resolves to. Bots of ordinary users never get the exception, and an entry in the allowlist does
nothing for them. Keep the list as narrow as the integration needs (for example a single
container name), never a whole private range, and remember that anything in it becomes
reachable by that admin's bots.

Residual risk: an admin's bot can reach allowlisted internal services with fixed-shape JSON
POSTs, which is the point of the allowlist. Responses are not shown to users beyond the
delivery log's status code and a short error string.

### Webhook and interaction endpoints are unauthenticated by design

`POST /api/webhooks/:id/:token` and `POST /api/interactions/:id/:token/followup` skip the
identity, Origin and per-user rate-limit checks because the path token is the credential,
exactly like Discord's webhook URLs. They are protected by the 256-bit token (constant-time
compare, wrong id and wrong token are indistinguishable), a per-webhook rate limit (30 per
minute, `429` with `Retry-After`), the message size limits, and `@everyone`/`@here` stripping.
Treat a webhook URL like a password: anyone holding it can post to that channel until the
webhook is deleted. Failed guesses are not rate limited per source; at 256 bits that is not a
practical attack, but it is the thing to add first if the surface ever becomes public.

## Desktop app

The desktop app (`apps/desktop`, Tauri v2) is a window around the user's own Harmony server. It does
not bundle the web client and has no credentials of its own.

### Identity and the server's checks are unchanged

Requests leave the PC through Tailscale and reach Serve like a browser's, so Serve attaches the
identity headers as usual. The page is loaded from the server's origin, so the `Origin` check in
[Why the Origin check matters most](#why-the-origin-check-matters-most) passes without any CORS
change, and no new server endpoint or header is trusted. The one server change is a
`service: "harmony"` field in the `/healthz` body (unauthenticated, no secrets) that lets the setup
page tell Harmony from any other web server.

### The IPC bridge

A webview that loads a remote page can let that page call native commands. That is the sensitive
part of the app: the page is whatever the configured server serves, and a compromised or
malicious server would otherwise gain code on the user's PC. The rules:

1. **Exactly one origin.** Access comes from a capability with `remote.urls` set to
   `<scheme>://<host>[:port]/*` for the configured server and nothing else, and `local: false`.
   It is built from the stored URL at startup and again when the setup page connects. The URL
   is first reduced to its origin (https, or http for `localhost` / `127.0.0.1` only), and the
   host is checked against `[A-Za-z0-9._-]` before it is put into the pattern.
2. **Two commands.** The capability lists `allow-notify` and `allow-set-badge`. There are no
   shell, filesystem, http, opener, updater or core-plugin permissions for the remote page.
   `build.rs` declares every app command, so Tauri denies any command that no capability grants.
3. **Setup commands are local only.** `connect_server` and `get_server_url` sit in a separate
   capability with no remote URL, so only the bundled setup page can call them.
4. **Validated arguments.** `notify(title, body, route)` accepts a title of 1 to 100 characters
   and a body of up to 300, neither with control characters (a body may contain newlines), and
   a `route` that is an absolute in-app path (`/...`, not `//...`) of at most 256 characters
   from a restricted alphabet. `set_badge(count)` takes an unsigned integer and clamps it to 999.
   Clicking a notification passes the route back through the same check before the page is told
   to navigate, and the route reaches the page as a JSON-encoded string.
5. **The old origin loses access.** Tauri 2.12 can add capabilities while running but cannot
   remove them, so each command also compares the calling webview's current URL with the
   session's origin and returns `forbidden` when they differ. "Change server…" clears the
   session before showing the setup page; connecting sets it to the new origin. After a restart
   only the stored origin has a capability at all.
6. **Navigation is confined.** The webview may show the bundled setup page and the configured
   origin. Any other navigation is cancelled and, for http, https and mailto, opened in the
   system browser; `target=_blank` and `window.open` are denied and opened there too. Redirects
   are not followed when the setup page probes the server.

Verified by a Rust test that sends real IPC requests through Tauri's access control with the
shipped capabilities: the configured origin can call `notify`, a different port, scheme, host or
look-alike suffix cannot, no remote page can call the setup commands, and the bundled page cannot
call `notify`.

### Residual risk

- The configured server is trusted with `notify` and `set_badge`. A compromised server can show
  notifications with text of its choosing and set the badge. It cannot run code, read files or
  navigate the app to another site.
- WebView2, WebKit and WebKitGTK are updated by the operating system. The app inherits their
  vulnerabilities and their sandbox.
- Installers are not code-signed yet (no Authenticode or Apple certificate), so a user cannot
  verify the publisher from the OS prompt. Updates are verified against the minisign public key
  in the app, which protects the update channel but not the first download, so download installers only from the
  project's releases page.
- The updater private key lives in GitHub Actions secrets and on the maintainer's machine; whoever
  holds it can ship an update to every installed app.
