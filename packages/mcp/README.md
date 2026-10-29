# @harmony/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an agent (Claude Code, Claude Desktop, any MCP client) use Harmony as its channel to people and to other agents: read a channel, post, ask a question and wait for the answer, ask for approval before a risky action, and show what it is doing in a live run panel.

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
| `start_run`, `update_run`, `finish_run`         | `panels.write` (plus `commands` for Cancel)   |
| `request_approval`                              | `messages.write`, `commands`                  |
| `#name` lookups (any tool that takes a channel) | `channels.read` (numeric ids work without it) |

A bot with `messages.read`, `messages.write` and `channels.read` covers the common loop.

### Environment

| Variable                        | Default                 | Meaning                                                                                                                               |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `HARMONY_BOT_TOKEN`             | required                | The bot token. Never printed or logged.                                                                                               |
| `HARMONY_URL`                   | `http://127.0.0.1:8471` | Base URL. The host-local integrations ingress accepts bot tokens without a proxy secret ([integrations](../../docs/integrations.md)). |
| `HARMONY_DEFAULT_CHANNEL`       | none                    | Channel id or `#name` used when a tool call omits `channel`.                                                                          |
| `HARMONY_MAX_SENDS_PER_MINUTE`  | `20`                    | Per-process cap on `send_message` plus `ask_human` (reactions get three times that).                                                  |
| `HARMONY_AGENT_CHANNEL`         | none                    | Channel (id or `#name`; a dashboard channel is fine) for `start_run` when a call names none.                                          |
| `HARMONY_APPROVAL_CHANNEL`      | the run's channel       | Where `request_approval` posts when a call names none. Must be a text channel (dashboards cannot hold messages).                      |
| `HARMONY_APPROVAL_PERMISSION`   | `manage_messages`       | Permission a person needs to press Approve, Deny or Cancel. The server enforces it on every click.                                    |
| `HARMONY_PANEL_MIN_INTERVAL_MS` | `1000`                  | At most one panel write per run in this time; updates in between are merged.                                                          |
| `HARMONY_ALLOW_MASS_MENTIONS`   | off                     | Set to `1` to stop neutralising `@everyone` / `@here` in outgoing text.                                                               |

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

### Agent hub tools

These make the agent visible and controllable. They need the bot to hold the `commands` scope and **no interactions URL**: button clicks then reach the MCP process over its own WebSocket (a gateway bot, see [integrations](../../docs/integrations.md#building-a-gateway-bot)). The whole picture, including the threat model, is in [docs/agents.md](../../docs/agents.md).

| Tool               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_approval` | `title`, `details` (Markdown, up to 2000), `risk` (`low`, `medium`, `high`: high asks for a second confirmation on Approve), `timeoutSeconds` (up to 3600, default 600), `requiredPermission`, `channel`, `runId`. Posts Approve and Deny buttons and waits. Returns `{decision: approved, denied, timeout or cancelled; by: {id, login, displayName}; at; messageId; channelId}`; only `approved` means go. The message is edited to show who decided and when, and loses its buttons. |
| `start_run`        | `title`, `channel`, `step`, `totalSteps`, `link`. Publishes a run panel: status, current step, step count, elapsed time, last five notes and a Cancel button. Returns `runId`.                                                                                                                                                                                                                                                                                                          |
| `update_run`       | `step` (a new text is the next step), `status` (`running`, `waiting_approval`, `waiting_reply`), `note`, `totalSteps`, `link`. Writes are merged: at most one panel write per second per run.                                                                                                                                                                                                                                                                                           |
| `finish_run`       | `status` (`done` or `failed`), `summary`. The panel keeps the result and loses its Cancel button.                                                                                                                                                                                                                                                                                                                                                                                       |

`request_approval` and `ask_human` set the run to waiting and back by themselves. After a person presses **Cancel run**, the run is marked cancelled, anything waiting on it returns `cancelled`, and **every later tool call** answers `This run was cancelled by X; stop working.` until a new `start_run`.

**One socket.** The MCP process holds a single WebSocket to Harmony (`src/gateway.ts`), opened when the first thing needs it and shared by every `wait_for_reply`, `ask_human`, pending approval and run with a Cancel button, so it stays far below the per-bot connection limit (3) and a click can never land on a socket that is about to close. It reconnects with backoff while anything needs it, resubscribes every watched channel from the newest message it saw (and re-reads over REST, so nothing sent during the gap is lost), and closes a second after the last need ends or when the MCP client disconnects.

Approvals live in the MCP process, keyed by message id, not on the socket. If the connection drops, the process reconnects with backoff and keeps waiting; a click while it is down tells the person the bot is `unreachable`, and clicking again after the reconnect works. A cancelled or timed-out approval edits its message ("Cancelled", "Timed out") so the channel never shows buttons that do nothing. The run panel's notes record every approval, denial and cancel with the person's name.

### Claude Code hook: `harmony-hook`

The second bin, `dist/hook-bin.js` (`harmony-hook`), is a [Claude Code hook](https://code.claude.com/docs/en/hooks) command. It reads the event JSON on stdin and acts:

| Event                              | Behaviour                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PreToolUse`                       | If the call matches `HARMONY_APPROVAL_PATTERN` (the Bash command, or `ToolName {json input}` for other tools), ask in Harmony and print `permissionDecision` `allow` (Approve), `deny` (Deny) or, on timeout, `deny` or `ask` as configured. Anything else: no output, and Claude Code proceeds as it would have. |
| `Notification`                     | Posts "Claude Code needs your input" with the notification `message`.                                                                                                                                                                                                                                             |
| `Stop`                             | Posts a short "finished its turn" note (the reply text only with `HARMONY_HOOK_INCLUDE_TEXT=1`).                                                                                                                                                                                                                  |
| `SessionStart`, `UserPromptSubmit` | With `HARMONY_HOOK_RUN=1`, keep one run panel per turn (needs `panels.write`); `Stop` finishes it. The prompt text stays out unless `HARMONY_HOOK_INCLUDE_TEXT=1`.                                                                                                                                                |

A hook is a short-lived process, so each approval wait opens **its own** gateway socket for the duration and closes it when the decision is made. Harmony delivers a button click to the bot's newest connection, so **only one process per bot should have an approval pending at a time**: a second hook (another Claude Code session) or an MCP server asking at the same moment would receive the first one's click, answer that it is no longer waiting, and leave the first waiting until its timeout. Give each concurrent session its own bot (or keep approvals to one session at a time). Notifications and `Stop` notes need no socket.

It never blocks Claude Code on a failure: any error (Harmony down, bad token, bad pattern, bad stdin) makes a `PreToolUse` answer **`ask`**, which is Claude Code's normal permission prompt, and every other event answer nothing; the exit code is always 0. A hard timeout (`HARMONY_HOOK_MAX_SECONDS`, default approval timeout plus 20 s) ends the wait with the same fallback. The token never appears in its output.

| Variable                                       | Default                | Meaning                                                                                 |
| ---------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `HARMONY_URL`, `HARMONY_BOT_TOKEN`             | see above              | As for the MCP server.                                                                  |
| `HARMONY_AGENT_CHANNEL`                        | required               | Text channel for approvals and notes.                                                   |
| `HARMONY_APPROVAL_PATTERN`                     | none (never asks)      | Regular expression, for example `git push\|rm -rf\|docker`.                             |
| `HARMONY_APPROVAL_TIMEOUT_SECONDS`             | `300`                  | 1 to 3600.                                                                              |
| `HARMONY_APPROVAL_ON_TIMEOUT`                  | `deny`                 | `deny`, or `ask` to hand back to the terminal prompt.                                   |
| `HARMONY_APPROVAL_RISK`                        | `medium`               | `high` asks for a second confirmation on Approve.                                       |
| `HARMONY_APPROVAL_PERMISSION`                  | `manage_messages`      | Who may decide.                                                                         |
| `HARMONY_HOOK_MAX_SECONDS`                     | timeout + 20           | Hard ceiling for one hook run.                                                          |
| `HARMONY_HOOK_RUN`, `HARMONY_HOOK_RUN_CHANNEL` | off, the agent channel | Optional run panel per turn, and the (dashboard) channel it lives in.                   |
| `HARMONY_HOOK_INCLUDE_TEXT`                    | off                    | Put prompt and reply text in the channel. Off because they can contain code or secrets. |

Paste into `.claude/settings.local.json` (not committed, since it holds the token) or `~/.claude/settings.json`; the hook `timeout` (seconds) must be longer than the approval wait:

```json
{
  "env": {
    "HARMONY_URL": "http://127.0.0.1:8471",
    "HARMONY_BOT_TOKEN": "hb_...",
    "HARMONY_AGENT_CHANNEL": "#approvals",
    "HARMONY_APPROVAL_PATTERN": "git push|rm -rf|docker|kubectl"
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/harmony/packages/mcp/dist/hook-bin.js",
            "timeout": 340
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/harmony/packages/mcp/dist/hook-bin.js",
            "timeout": 20
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/harmony/packages/mcp/dist/hook-bin.js",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

The schema is from the official hooks reference (<https://code.claude.com/docs/en/hooks>, where <https://docs.claude.com/en/docs/claude-code/hooks> redirects; read on 2026-10-29). Hook input on stdin carries `session_id`, `cwd`, `hook_event_name` and, per event, `tool_name` and `tool_input` (PreToolUse), `message`, `title` and `notification_type` (Notification), `prompt` (UserPromptSubmit), `last_assistant_message` (Stop). A `PreToolUse` hook answers on stdout with exit code 0 and

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "..."
  }
}
```

where `permissionDecision` is `allow`, `deny`, `ask` or `defer`; `ask` shows the normal prompt, `defer` is only honoured in non-interactive mode and is not used here, and a hook `timeout` is in seconds. Note that `allow` skips Claude Code's own prompt for that call: the person's click in Harmony is the approval.

There is also one resource template, `harmony://channel/{id}/recent`, with the last 30 messages.

Not provided: `set_status`. Presence and profile changes are human-only in Harmony (`presence.set` and `PATCH /api/me` answer bots with `human_only`), and this server does not work around that.

How `wait_for_reply` works: it opens the `/api/ws` gateway with the bot's `Authorization` header, subscribes with `lastSeenId` (so a reply that arrived between sending and subscribing comes back in the backfill) and takes the first matching `message.created`. If the socket drops it reconnects with backoff and resubscribes from the last id it saw. After three failed connection attempts in a row it polls `GET /api/channels/:id/messages` every two seconds instead. A "match" is a message newer than `afterMessageId` (default: the newest message when the call starts) that is not the bot's own, not deleted and, unless `includeBots` is set, not from a bot or webhook. While waiting it sends MCP progress notifications when the client asked for them, so clients with a request timeout stay connected.

Errors come back as tool errors with a message you can act on: `missing_scope` names the scopes to add, `forbidden` says the bot is probably not in that server or channel, `missing_permission` says to grant the permission to a role the bot holds, `invalid_token` says to rotate the token, and an unreachable `HARMONY_URL` says so.

## Safety

- **Chat is untrusted input.** Anyone who can post where the bot can read can try to give your agent instructions (prompt injection). Tool descriptions and every transcript start with a notice saying so, and continuation lines of a message are indented so a message cannot forge another author's line. Still: do not give an agent that reads open channels tools or credentials it should not use on a stranger's say-so, and prefer `fromUser` or a private channel for approvals. A human saying "yes" in `ask_human` is the signal; text inside a quoted message is not.
- **No new privileges.** The bot token is the only credential. Give the bot the narrowest scopes and put it only in the servers and channels it needs. The server never uses a human identity.
- **No mass mentions.** `@everyone` and `@here` are broken with a zero-width space unless `HARMONY_ALLOW_MASS_MENTIONS=1`. `<@userId>` mentions of single people work.
- **Approvals are the control for side effects.** A person pressing a button, with the permission the server checks, is the only thing that returns `approved`; text in a message never does. [docs/agents.md](../../docs/agents.md) says what this does and does not protect against.
- **Bot loops.** Harmony counts bot-to-bot reply hops and refuses a chain longer than `BOT_MAX_HOPS` (`429 bot_loop`) and a channel's bot-to-bot traffic over `BOT_BUDGET_MAX` per window (`429 bot_budget`). `wait_for_reply` still ignores bots unless `includeBots` is set.
- **Rate limits.** A rolling per-process limit (default 20 sends a minute) turns a looping agent into an error result instead of a flood. Harmony applies its own message, reaction and per-bot request limits on top.
- **The token stays out of logs.** It is read from the environment, sent only in the `Authorization` header, and never written to stdout (which carries the protocol) or stderr. Put it in the client's secret store or environment, not in a command line you share.

## Development

```sh
pnpm --filter @harmony/mcp test:unit   # fake Harmony HTTP and WebSocket server, in-memory MCP client
pnpm --filter @harmony/mcp build
```

`src/client.ts` is a small typed REST and WebSocket client (`HarmonyClient`, `HarmonyError`) that other tooling can reuse. `apps/server/tests/integration/mcp-package.test.ts` drives the built stdio server against the real app.
