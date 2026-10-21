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

- nginx is published on `127.0.0.1:8470` only. Other tailnet peers and LAN
  devices cannot reach it directly; connecting to `<tailnet-ip>:8470` is refused.
  The only route in from the network is through Serve.
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

Machine clients (webhooks, bots) never use identity headers. They authenticate
with bearer tokens on a separate path, and any `Tailscale-*` headers on that path
are ignored.
