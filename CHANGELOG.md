# Changelog

All notable changes to Harmony are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Design decisions and measurements behind them are in [NOTES.md](NOTES.md).

## [Unreleased]

### Fixed

- **Agent approvals only match commands that run.** The hook tested `HARMONY_APPROVAL_PATTERN` against the whole Bash command, so a command that merely mentioned a watched command (in an `echo`, a commit message or a heredoc) asked for approval and blocked the agent until the timeout. It now drops quoted strings and heredoc bodies and tests each `;`, `&&`, `||`, `|` or newline separated part; anchor patterns with `^`.

## [0.3.0] - 2026-10-30

### Upgrading

Run `scripts/deploy.sh`. Back up Postgres first: migrations 0018 to 0025 run on start and only move forward (there is no 0023; it was renumbered to 0025 before release).

- **Lobby replaces the default server (0018).** New users used to be added to the first server automatically. `guilds.is_default` now marks an optional lobby that an instance admin picks under Settings, Instance, Lobby server, and the migration clears it on existing installs. Until an admin picks a lobby, newcomers join nothing and find people through Home, All members, or an invite. The first user still gets a starter server, which is not the lobby.
- **Presence reset (0022).** Every stored `idle` status is set to `online`: older clients saved automatic idle as the chosen status, so nearly all of them were stale. Someone who really chose Idle picks it again once. Automatic idle is now computed per connection and never stored.
- **Dashboard channels refuse messages (0019).** A channel of the new `dashboard` kind only shows bot panels; posting to it fails with `dashboard_channel`. Buttons there answer privately (ephemeral replies).
- Other migrations add columns and tables only: gateway event numbering (0020), webhook formats (0021), bot channels, feed mode and schedules (0024), and a bot reply-chain counter on messages (0025).

### Added

- **Members directory and DM invites.** Home has an All members tab; a server invite can be sent as a direct message and renders as an invite card.
- **Bot panels, dashboards and buttons.** Bots publish declarative views (stats, charts, tables, status lists, buttons) into dashboard channels or pinned above a text channel. Buttons send signed `action` interactions; panels update live. [Guide](docs/integrations.md#panels-and-buttons).
- **Gateway bots.** A bot with no URL connects out over the WebSocket and receives slash commands, button clicks and numbered, acknowledged, resumable events. [Guide](docs/integrations.md#building-a-gateway-bot).
- **Webhook presets and templates.** Forgejo, GitHub, Alertmanager, Grafana, Watchtower, generic JSON and declarative templates, with optional signature checks, a live preview and a webhook editor. [Guide](docs/integrations.md#webhook-presets-and-templates).
- **Bot channels.** Managers assign bots to a channel (header chips, their commands first) and can make it a bot feed where only bots and moderators post. Bots register schedules (interval or cron) and get a signed `refresh` interaction. [Guide](docs/integrations.md#scheduling-refreshes).
- **MCP server and AI agent hub.** `@harmony/mcp` lets agents such as Claude Code read, post and ask questions through a bot token; agents request approval with Approve and Deny buttons and show live run panels with Cancel; `harmony-hook` routes risky Claude Code commands to a person. Bot-to-bot reply chains and per-channel bot traffic are limited. [Guide](docs/agents.md).
- **Agent control room.** `harmony-agentd`, a local daemon the Claude Code hook starts on demand, shows each session and each subagent (including those an orchestrator spawns) as dashboard panels and lets people with the permission stop a subagent or a session, pause and resume it, or send it a note from chat; approvals name the agent that asked. [Guide](docs/agents.md#agent-control-room).
- **Homelab bot example** with a locked-down Docker socket proxy: [examples/homelab-bot](examples/homelab-bot/README.md).
- Per-device presence: the status menu shows a dot per status and marks the current choice.
- Native selects, checkboxes and color inputs follow the theme; eight chart color tokens were added to the theme allowlist.

### Changed

- Profile banners are full bleed and the profile card has more room; the slash-command composer stays one scrolling row on phones, and boolean options show as true/false chips.
- On screens narrower than 600 px the channel header shows the bot feed marker as an icon and at most one bot avatar (plus a count), so the channel name is not truncated.
- Closing a gateway socket now also happens when its bot is revoked.
- The screenshot run starts its own delivery worker, and the screenshots in `docs/screenshots` were regenerated for the current UI.

### Fixed

- Status stuck on Idle after a second device went quiet.
- Status menu dots showed no colour (an unscoped panel style overrode them).

## Earlier releases

0.2.1, 0.2.0 and 0.1.0 are described on the [Releases page](https://github.com/Syed04Wajeeh/harmony-chat/releases).

[0.3.0]: https://github.com/Syed04Wajeeh/harmony-chat/compare/v0.2.1...v0.3.0
