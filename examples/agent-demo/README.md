# Agent demo

A scripted agent (`demo.ts`) that drives Harmony through the [MCP server](../../packages/mcp/README.md) with the MCP SDK client, the same way Claude would: `start_run`, `update_run`, `request_approval` (waits for a person), `finish_run`. It is the quickest way to see the [agent hub](../../docs/agents.md) work.

## Run it

1. Build the MCP server: `pnpm install && pnpm build:shared && pnpm --filter @harmony/mcp build`.
2. In Harmony create a **dashboard channel** (for the run panel) and a **text channel** (for approvals) in a server you manage.
3. Create a bot with the scopes `messages.read`, `messages.write`, `channels.read`, `panels.write` and `commands` and **no interactions URL**, and add it to that server. Keep the token.
4. Run it:

```sh
HARMONY_URL=http://127.0.0.1:8471 \
HARMONY_BOT_TOKEN=hb_... \
DEMO_DASHBOARD_CHANNEL='#agents' \
DEMO_APPROVAL_CHANNEL='#approvals' \
pnpm --filter @harmony/example-agent-demo start
```

Open the dashboard channel: the run panel appears and updates. After a few seconds the agent asks to deploy; press **Approve** (it is a high-risk request, so you confirm twice) or **Deny** in the approvals channel. Press **Cancel run** on the panel instead and the next tool call tells the agent to stop. Pace and timeouts: `DEMO_PACE_MS` (default 2500) and `DEMO_APPROVAL_SECONDS` (default 600).

For Claude Code itself, register the MCP server and the hook as described in the [package README](../../packages/mcp/README.md#claude-code-hook-harmony-hook).
