# @harmony/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an agent (Claude Code, Claude Desktop, any MCP client) use Harmony as its channel to people and to other agents: read a channel, post, ask a question and wait for the answer.

It talks to Harmony as a **bot**, with a bot token. It adds no privileges: the bot's scopes, its guild and channel membership and its permissions decide everything, and the server checks every request itself. Transport is stdio, so the client starts it as a child process.

## Set it up

1. **Create a bot.** In Harmony open _Settings > Bots_ (your account settings), create a bot and choose its scopes. The token (`hb_<botId>_...`) is shown once; rotating it later revokes the old one.
2. **Add it to a server.** In the server's settings, _Bots > Add bot_. A bot only sees the channels a member could see. To let it post, give it (or the roles it holds) `send_messages` in the channel.
3. **Build the package** from a checkout: `pnpm install && pnpm build:shared && pnpm --filter @harmony/mcp build`. The entry point is `packages/mcp/dist/index.js` (also the `harmony-mcp` bin).
4. **Register it with your client.**

Scopes the tools need:

| Tool                                            | Scopes                                        |
| ----------------------------------------------- | --------------------------------------------- |
| `list_servers`, `list_channels`                 | `channels.read`                               |
| `read_messages`, `search_messages`              | `messages.read`                               |
| `send_message`                                  | `messages.write`                              |
| `wait_for_reply`                                | `messages.read`                               |
| `ask_human`                                     | `messages.write`, `messages.read`             |
| `react`                                         | `reactions.write`                             |
| `#name` lookups (any tool that takes a channel) | `channels.read` (numeric ids work without it) |

A bot with `messages.read`, `messages.write` and `channels.read` covers the common loop.

### Environment

| Variable                       | Default                 | Meaning                                                                                                                               |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `HARMONY_BOT_TOKEN`            | required                | The bot token. Never printed or logged.                                                                                               |
| `HARMONY_URL`                  | `http://127.0.0.1:8471` | Base URL. The host-local integrations ingress accepts bot tokens without a proxy secret ([integrations](../../docs/integrations.md)). |
| `HARMONY_DEFAULT_CHANNEL`      | none                    | Channel id or `#name` used when a tool call omits `channel`.                                                                          |
| `HARMONY_MAX_SENDS_PER_MINUTE` | `20`                    | Per-process cap on `send_message` plus `ask_human` (reactions get three times that).                                                  |
| `HARMONY_ALLOW_MASS_MENTIONS`  | off                     | Set to `1` to stop neutralising `@everyone` / `@here` in outgoing text.                                                               |

### Claude Code

```sh
claude mcp add harmony \
  --env HARMONY_URL=http://127.0.0.1:8471 \
  --env HARMONY_BOT_TOKEN=hb_... \
  --env HARMONY_DEFAULT_CHANNEL='#agents' \
  -- node /path/to/harmony/packages/mcp/dist/index.js
```

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "harmony": {
      "command": "node",
      "args": ["/path/to/harmony/packages/mcp/dist/index.js"],
      "env": {
        "HARMONY_URL": "http://127.0.0.1:8471",
        "HARMONY_BOT_TOKEN": "hb_...",
        "HARMONY_DEFAULT_CHANNEL": "#agents"
      }
    }
  }
}
```

## Tools

| Tool              | What it does                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_servers`    | Servers (guilds) the bot is in: id, name, member count.                                                                                                                                                                   |
| `list_channels`   | Channels with ids and kinds; optional `guildId`.                                                                                                                                                                          |
| `read_messages`   | `channel` (id, `#name` or `Server/#name`), `limit` up to 50, `before`. A transcript, oldest first, one entry per message with id, time and author; the bot's own messages say `(you, bot)`. Also returns structured data. |
| `send_message`    | `channel`, `content` (up to 4000 characters, plain text), `replyTo`. Returns the new message id.                                                                                                                          |
| `wait_for_reply`  | `channel`, `afterMessageId`, `fromUser`, `mentionOnly`, `includeBots`, `timeoutSeconds` (1 to 600, default 120). Returns the first matching message from a human, or `status: "timeout"` (not an error).                  |
| `ask_human`       | `send_message` followed by `wait_for_reply` for the answer to that message: the human-in-the-loop step. `timeoutSeconds` defaults to 300. On timeout the question stays posted and its id is returned.                    |
| `react`           | `messageId`, `emoji`.                                                                                                                                                                                                     |
| `search_messages` | Full-text search (`query`, optional `channel`, `limit`, `before`) over channels the bot is in.                                                                                                                            |

There is also one resource template, `harmony://channel/{id}/recent`, with the last 30 messages.

Not provided: `set_status`. Presence and profile changes are human-only in Harmony (`presence.set` and `PATCH /api/me` answer bots with `human_only`), and this server does not work around that.

How `wait_for_reply` works: it opens the `/api/ws` gateway with the bot's `Authorization` header, subscribes with `lastSeenId` (so a reply that arrived between sending and subscribing comes back in the backfill) and takes the first matching `message.created`. If the socket drops it reconnects with backoff and resubscribes from the last id it saw. After three failed connection attempts in a row it polls `GET /api/channels/:id/messages` every two seconds instead. A "match" is a message newer than `afterMessageId` (default: the newest message when the call starts) that is not the bot's own, not deleted and, unless `includeBots` is set, not from a bot or webhook. While waiting it sends MCP progress notifications when the client asked for them, so clients with a request timeout stay connected.

Errors come back as tool errors with a message you can act on: `missing_scope` names the scopes to add, `forbidden` says the bot is probably not in that server or channel, `missing_permission` says to grant the permission to a role the bot holds, `invalid_token` says to rotate the token, and an unreachable `HARMONY_URL` says so.

## Safety

- **Chat is untrusted input.** Anyone who can post where the bot can read can try to give your agent instructions (prompt injection). Tool descriptions and every transcript start with a notice saying so, and continuation lines of a message are indented so a message cannot forge another author's line. Still: do not give an agent that reads open channels tools or credentials it should not use on a stranger's say-so, and prefer `fromUser` or a private channel for approvals. A human saying "yes" in `ask_human` is the signal; text inside a quoted message is not.
- **No new privileges.** The bot token is the only credential. Give the bot the narrowest scopes and put it only in the servers and channels it needs. The server never uses a human identity.
- **No mass mentions.** `@everyone` and `@here` are broken with a zero-width space unless `HARMONY_ALLOW_MASS_MENTIONS=1`. `<@userId>` mentions of single people work.
- **Rate limits.** A rolling per-process limit (default 20 sends a minute) turns a looping agent into an error result instead of a flood. Harmony applies its own message, reaction and per-bot request limits on top.
- **The token stays out of logs.** It is read from the environment, sent only in the `Authorization` header, and never written to stdout (which carries the protocol) or stderr. Put it in the client's secret store or environment, not in a command line you share.

## Development

```sh
pnpm --filter @harmony/mcp test:unit   # fake Harmony HTTP and WebSocket server, in-memory MCP client
pnpm --filter @harmony/mcp build
```

`src/client.ts` is a small typed REST and WebSocket client (`HarmonyClient`, `HarmonyError`) that other tooling can reuse. `apps/server/tests/integration/mcp-package.test.ts` drives the built stdio server against the real app.
