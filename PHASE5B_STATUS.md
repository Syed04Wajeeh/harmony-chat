# Phase 5b status (roles and permissions)

Stopped early on request. The tree typechecks (`pnpm typecheck`), lint and unit tests passed
earlier (server 393 unit, web 189), and all 270 server integration tests passed (including the
unchanged 6-statement send test). harmony-dev and harmony-load were torn down.

## Done
- Shared: `packages/shared/src/permissions.ts` (keys, defaults, schemas, pure `computePermissions`,
  hierarchy helpers), new events in `protocol.ts`, `authorNickname` on messages.
- Migration `0015_roles` (roles, member_roles, channel_overwrites, nickname, default-role trigger,
  private channels converted to overwrites; owner and instance admin get rows in private channels).
- Server: `src/permissions/` (cache with Redis invalidation, loader, reconcile of channel_members),
  `src/roles/` (service and routes), enforcement in channels, messages, typing, guilds, bots,
  webhooks, modules (`ctx.permissions.has/require/requireInChannel`), reactions, pins, polls,
  uploads (`?channelId=`), kick, transfer, nicknames, `/permissions/@me`.
- Tests: unit permissions (16), integration permissions (34), migration with data (1).
- Web: roles page, members page, channel settings (overview and tri-state overwrites), role colors
  with lightness clamp, hoisted member list, permission-based hiding, e2e `roles.spec.ts` (passes,
  full e2e suite 12 passed 1 skipped as before), 7 new screenshots in docs/screenshots (reviewed).

## Not done
- Docs: `docs/permissions.md` (worked example), `docs/api/protocol.md`, `docs/modules.md`
  (`ctx.permissions`), trust-model, README, and the NOTES.md decisions dated 2026-10-22. Decisions to
  record: text[] keys; added `create_channels` key (members could create channels, `manage_channels`
  would also grant editing); `pins.pin` OR `manage_messages` for pinning; `polls.create/vote` in
  @everyone; owner/admin see all channels; channel creator keeps edit of own channel; private
  channel = @everyone view deny overwrite; uploads check `attach_files` only when `channelId` given
  (and always at send); channel to guild lookup cached (first lookup per channel is one query);
  default role via DB trigger; typing silently dropped without `send_messages`.
- Perf: one 900 msg/s fan-out run was done on a fresh harmony-load stack and did NOT match the
  earlier result: achieved 749.5 msg/s, p50 1344 ms, p95 1415 ms, 0 missing deliveries, 0 errors
  (raw file in `loadtest/results/2026-10-22-fanout-perms-two-900.k6.json`). Cause not investigated:
  could be a real regression (permission check, extra join to channels/guild_members in the message
  reader query) or the seeded world (raw SQL, cold caches). Needs a repeat and a CPU profile
  (`loadtest/scripts/cpuprofile.ts`) before anything is written to docs/performance.md.
- Minor UI: two back arrows on mobile role editor; mention_everyone and manage_emoji are defined but
  enforce nothing (no such features exist).
