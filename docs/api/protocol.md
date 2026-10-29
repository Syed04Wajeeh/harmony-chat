# Harmony API and WebSocket protocol

This is the contract between the server and the web client. The authoritative schemas are the
zod definitions in `packages/shared/src` (`chat.ts`, `bots.ts`, `protocol.ts`); this document explains
behavior and gives examples.

## Conventions

- Base path `/api`. Bodies are JSON (`Content-Type: application/json`) except uploads.
- **Ids are strings** of decimal digits (`"42"`), never numbers. Attachment ids are UUIDs. Guild
  invite codes are 10 URL-safe characters.
- Timestamps are ISO 8601 UTC strings (`"2026-10-22T09:15:00.000Z"`).
- Identity comes from the Tailscale headers added by the proxy; there is no login. Every
  non-GET request and the WebSocket upgrade must carry an `Origin` equal to the public origin
  (browsers do this automatically), otherwise `403 bad_origin`. Bots and integrations use
  `Authorization: Bot <token>` instead; see [Bots and integrations](#bots-and-integrations).
- Errors are `{ "code": "...", "message": "..." }` with the HTTP status shown below. Common to
  all endpoints:

| Status  | code                 | Meaning                                                                                                                                                               |
| ------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400     | `invalid_request`    | Body, query or params failed validation                                                                                                                               |
| 401/403 | auth codes           | `no_identity`, `proxy_required`, `not_allowed`, `bad_origin`; bots: `invalid_token`, `missing_scope`, `human_only`, `bot_not_allowed`                                 |
| 403     | `forbidden`          | Authenticated but not allowed (usually: not a member)                                                                                                                 |
| 403     | `missing_permission` | A member without the [permission](../permissions.md) the action needs; the message names it                                                                           |
| 403     | `role_hierarchy`     | The target role or member ranks at or above you                                                                                                                       |
| 404     | `*_not_found`        | Resource does not exist (`channel_not_found`, `message_not_found`, `guild_not_found`, `user_not_found`, `attachment_not_found`, `invite_not_found`, `role_not_found`) |
| 429     | `rate_limited`       | Too many requests, sends, reactions or uploads                                                                                                                        |

- A channel, message or guild you cannot access answers **403 `forbidden`**, not 404, when it
  exists. Unknown ids answer 404.
- Everything is newest-id-wins ordered by numeric id. Compare ids as BigInt or by (length, string).

## Concepts

- **Guild** (the UI calls it a "server"): a group of users with channels. Any signed-in user can
  create one and becomes its owner. `users.isAdmin` is an instance-level moderation override
  only; it is never required to create guilds or channels.
- **Channel**: `kind: "text"` belongs to exactly one guild (`guildId`); `kind: "dm"` has
  `guildId: null`, `name: null`, exactly two members and lives outside any guild.
- **Roles and permissions**: what a member may do is decided by their roles and by per-channel
  overwrites; see [permissions.md](../permissions.md). `403 missing_permission` means "you are a
  member but lack the key". The guild owner and instance admins hold every permission.
- **Visibility**: whoever holds `view_channel` in a text channel is a member of it (they get a
  membership row automatically, including when they join the guild later or are granted a role). A
  private channel (`isPrivate: true`) is one where @everyone is denied `view_channel`; it is visible
  to the members it is allowed for, **and always to the guild owner and instance admins**. DMs are
  private to their two users.
- **Unread counts** (`unreadCount`, `mentionCount`) never exceed 100; `100` means "100 or more".
  They count messages after `lastReadMessageId` that are not yours and not deleted.
- **Lobby guild**: new users join no guild on their first request, unless an instance admin picked a lobby guild (`PUT /api/admin/lobby`); then they join that one. The very first user of an empty instance gets a starter guild ("Harmony") that is not the lobby.

## Types

```jsonc
// User (public profile, also message author)
{ "id": "7", "login": "ada@example.com", "displayName": "Ada", "avatarUrl": null }

// DirectoryUser = User + isAdmin
{ "id": "7", "login": "ada@example.com", "displayName": "Ada", "avatarUrl": null, "isAdmin": false }

// Me = DirectoryUser + status ("online" | "idle" | "dnd" | "invisible", the status you chose)
{ "id": "7", "login": "ada@example.com", "displayName": "Ada", "avatarUrl": null, "isAdmin": false, "status": "online" }

// Guild
{ "id": "3", "name": "Book club", "iconUrl": "/api/attachments/6f1c.../icon.png", "ownerId": "7", "memberCount": 4 }

// GuildSummary = Guild + counts summed over your channels in it (each capped at 100)
{ "id": "3", "name": "Book club", "iconUrl": null, "ownerId": "7", "memberCount": 4, "unreadCount": 12, "mentionCount": 1 }

// Channel
{ "id": "11", "guildId": "3", "kind": "text", "name": "general", "topic": "Hello",
  "isPrivate": false, "createdBy": "7", "dmUser": null }

// Role (position 0 is always @everyone, isDefault true; higher outranks lower)
{ "id": "21", "guildId": "3", "name": "Moderator", "color": 16711680, "position": 2,
  "hoist": true, "mentionable": false, "permissions": ["manage_messages", "polls.create"], "isDefault": false }

// ChannelOverwrite (targetType "role" | "member")
{ "channelId": "11", "targetType": "role", "targetId": "20", "allow": [], "deny": ["view_channel"] }

// GuildMember = DirectoryUser + status, joinedAt, roleIds (without @everyone), nickname, topRoleColor
{ "id": "7", "login": "ada@example.com", "displayName": "Ada", "avatarUrl": null, "isAdmin": false,
  "status": "online", "joinedAt": "2026-10-22T09:00:00.000Z", "roleIds": ["21"], "nickname": "Ada L.",
  "topRoleColor": 16711680 }

// ChannelSummary = Channel + your read state. For a DM, name is null and dmUser is the other person.
{ "id": "11", "guildId": "3", "kind": "text", "name": "general", "topic": "Hello",
  "isPrivate": false, "createdBy": "7", "dmUser": null,
  "unreadCount": 3, "mentionCount": 0, "lastMessageId": "980", "lastReadMessageId": "977" }

// Message
{
  "id": "981", "channelId": "11",
  "author": { "id": "7", "login": "ada@example.com", "displayName": "Ada", "avatarUrl": null },
  "authorNickname": "Ada L.",
  "content": "hello <@8>",
  "createdAt": "2026-10-22T09:15:00.000Z",
  "editedAt": null,
  "deleted": false,
  "pinnedAt": null, "pinnedBy": null,
  "replyTo": { "id": "975", "authorId": "8", "contentPreview": "first 100 chars...", "deleted": false },
  "reactions": [ { "emoji": "👍", "count": 2, "userIds": ["7", "8"] } ],
  "attachments": [ {
    "id": "0b0c2d5e-6a53-4f5e-9d8e-0d6b1c1f0a11", "filename": "cat.png", "contentType": "image/png",
    "sizeBytes": 20481, "width": 640, "height": 480,
    "url": "/api/attachments/0b0c2d5e-6a53-4f5e-9d8e-0d6b1c1f0a11/cat.png" } ],
  "mentions": ["8"],
  "modules": { "polls": { "...Poll": "..." } }
}
```

Message notes:

- `authorNickname` is the author's nickname in the message's guild; it is absent for DMs, authors
  without a nickname and people who left. It is the nickname at the time the message is served.

- `modules` is present only on messages a module attached data to, keyed by module id (see
  [Modules](#modules)). Clients validate each entry themselves and ignore ids they do not know.

- `content` may be empty only when the message has attachments (or is deleted).
- A deleted message is served as a tombstone: `deleted: true`, `content: ""`, no attachments,
  reactions, mentions, reply or pin info. Render it as "message deleted" or drop it.
- `replyTo` is `null` for non-replies. If the parent was deleted, `deleted: true` and
  `contentPreview: ""`.
- `reactions` lists each emoji once with its total `count` and the first 20 `userIds`.
- Mentions are written by the client as `<@userId>` in `content`. The server records only
  mentions of other members of the channel, and returns them in `mentions`.
- Attachment `url` is same-origin; fetch it with the normal identity (an `<img src>` works).

## Users and presence

### `GET /api/me`

Response `200` Me.

### `PATCH /api/me`

Body `{ "status": "online" | "idle" | "dnd" | "invisible" }`. Response `200` Me. `invisible`
makes you appear offline to everyone else. Other tabs are not notified; they learn it from the
response of whichever tab changed it.

### `GET /api/users`

Response `200` `{ "users": DirectoryUser[], "profiles": { "<userId>": ProfileSummary } }`: you plus
everyone who shares at least one guild with you, ordered by display name. `profiles` holds a
summary only for users who have something to show (an accent color, a custom status or explicit
perks). Use for mention autocomplete and starting DMs.

### `GET /api/directory?q=&kind=human|bot&notInGuild=<id>&limit=<1..100, default 50>&offset=`

Everyone who has signed in to this instance, whether or not you share a guild, ordered by display
name. `q` matches display name or login (case-insensitive substring). `kind` defaults to `human`;
bots are listed only with `kind=bot`. `notInGuild` keeps only people outside that guild (for the
invite picker) and needs you to be a member of it (`403` otherwise). Response `200`
`{ "users": DirectoryUser[], "profiles": {...}, "presence": [{ "userId", "status" }], "total": 12 }`;
`presence` is the current status of the users on this page (invisible users read as offline), and
`total` counts all matches. Humans only: the endpoint is not available to bots.

### `GET /api/admin/lobby` and `PUT /api/admin/lobby`

Instance admins only (`403` otherwise). Response `200` `{ "guildId": "3" | null }`. `PUT` takes
the same body: the guild every new user joins on first sign-in, or `null` for none (the default).
`404` for an unknown guild. Existing users are not moved.

### `GET /api/presence`

Response `200` `{ "presence": [ { "userId": "8", "status": "online" | "idle" | "dnd" } ] }`.
Users that are not listed are offline (this includes invisible users). **Scoped**: only you and
people who share at least one guild or DM with you are ever listed, so you cannot look up whether
a stranger is online. Fetch it after each `hello` (the socket is already receiving presence for
your guilds and DMs by then, so nothing falls between the snapshot and the frames that follow),
then apply `presence.batch` frames. Where a batch update and the snapshot disagree, the batch
update is newer if it arrived after the request was sent. Fetch it again when you join or leave a
guild or get a DM.

## Settings and themes

Per-user, human sessions only. Appearance and behavior preferences live on the server so every
device agrees; the shapes are the `UserSettings`, `CustomTheme` and `ThemeInput` schemas in
`packages/shared`.

### `GET /api/me/settings`

Response `200` `{ appearance, behavior, version, updatedAt }`. A user who never saved gets the
defaults at `version: 0`. `appearance` holds `mode` (`system`/`dark`/`light`), `themeId` (a preset
id or one of your theme ids), `density`, `panels`, `fontScale` (0.875 to 1.25), `messageFont`,
`useGuildAccent`, `reducedMotion` (`system`/`on`/`off`), `customCssEnabled` and `customCss`.
`behavior` holds `timeFormat`, `showAvatars`, `messageGrouping`, `memberListDefault`,
`sendOnEnter`, `linkPreviews` (reserved) and `autoIdleMinutes`.

### `PATCH /api/me/settings`

Body `{ "version": n, "appearance"?: {...}, "behavior"?: {...} }` with only the changed fields.
Optimistic concurrency: `version` must equal the stored one, otherwise `409 version_conflict` and
nothing is applied; the client refetches, replays its change on the fresh copy and retries.
`customCss` is sanitized before it is stored (see the trust model) and is at most 20 KB. Response
`200` the saved settings with the new `version`. Errors: `400` (out of range, unknown `themeId`),
`409 version_conflict`. The user's other sessions receive `settings.updated`.

### `GET /api/me/themes`, `POST /api/me/themes`, `PUT /api/me/themes/:id`, `DELETE /api/me/themes/:id`

A theme is `{ name (1..40), base: "dark" | "light", tokens }`. `tokens` may set only the semantic
tokens in the allowlist (`COLOR_TOKENS` and the radius tokens in `@harmony/shared`); colors must be
hex, `rgb()` or `hsl()`, lengths are bounded. Anything else (`url()`, `var()`, `;`, `}`, comments,
unknown names) is `400`. At most 20 themes per user (`400 theme_limit`). Other users' themes are
`404`. Deleting the selected theme resets `themeId` to the default. Every change sends
`themes.updated` with the full list to the user's sessions.

## Guilds

### `GET /api/guilds`

Response `200` `{ "guilds": GuildSummary[] }`, ordered by name.

### `POST /api/guilds`

Body `{ "name": "Book club" }` (trimmed, 1-100 chars). Response `201` GuildSummary. The caller
becomes owner and member, and a `general` channel is created. Errors: `400`.

### `PATCH /api/guilds/:id`

Needs `manage_guild`. Body: any of `{ "name": string, "iconAttachmentId": uuid | null,
"bannerAttachmentId": uuid | null, "accentColor": 0..16777215 | null, "description": string | null }`
(at least one; description is at most 300 characters, empty clears it). The icon and the banner
must be images (png, jpeg, gif or webp) uploaded by you with `POST /api/uploads` and not yet
attached to a message; `null` removes them. Response `200` Guild, which carries `accentColor`,
`bannerUrl` and `description` (all nullable). Errors: `400 invalid_icon`, `400 invalid_banner`,
`403 missing_permission`, `404 guild_not_found`.

### `DELETE /api/guilds/:id`

Owner (or instance admin) only. Deletes the guild, its channels and messages. Response `204`.
Members receive `channel.removed` for every channel and then `guild.removed`.

### `POST /api/guilds/:id/leave`

Response `204`. You lose access to all channels of the guild, including private ones.
Errors: `400 owner_cannot_leave` (the owner must delete the guild), `403` if not a member.

### `GET /api/guilds/:id/channels`

Members only. Response `200` `{ "channels": ChannelSummary[] }`: the channels where you hold
`view_channel` (public ones, private ones you may see, and all of them for the owner and instance
admins), archived channels excluded.

### `POST /api/guilds/:id/channels`

Needs `create_channels`. Body `{ "name": "dev-chat", "topic"?: string (<=256), "isPrivate"?: boolean, "kind"?: "text" | "dashboard" }`
(`kind` defaults to `text`; a `dashboard` channel shows panels instead of messages and refuses
messages with `400 dashboard_channel`);
`name` matches `^[a-z0-9-]{1,32}$` and is unique within the guild. Response `201` ChannelSummary.
A public channel appears for every member who holds `view_channel` (`channel.joined`); a private one
is created with an @everyone deny and an allow for you, and appears for you, the owner and instance
admins. Errors: `400`, `403 missing_permission`, `409 name_taken`.

### `GET /api/guilds/:id/members`

Members only. Response `200` `{ "members": GuildMember[] }`. `roleIds` lists the roles the member
holds (not @everyone), `nickname` is `null` when unset and `topRoleColor` is the color of their
highest role that has one.

### `POST /api/guilds/:id/transfer`

Humans only; **the owner only** (an instance admin cannot). Body `{ "userId": "8" }`, a human member.
Response `200` Guild with the new `ownerId`. The previous owner becomes an ordinary member, subject
to roles. Errors: `400 invalid_request` (yourself, a bot), `403 forbidden`, `404 user_not_found`.
Members receive `guild.updated`, and `channel.joined` / `channel.removed` where access changed.

### `DELETE /api/guilds/:id/members/:userId`

Humans only. Removes a member (a kick). Needs `kick_members` and a higher rank than the target
(`403 role_hierarchy`). Response `204`. The removed user receives `channel.removed` for every
channel of the guild and then `guild.removed`; the others receive `guild.member_left`. Errors:
`400 invalid_request` (yourself), `403 missing_permission`, `404 user_not_found`.

### `PATCH /api/guilds/:id/members/:userId`

Humans only. Body `{ "nickname": "Ada L." | null }` (trimmed, 1-32 chars; `null` clears). Your own
needs `change_nickname`; someone else's needs `manage_nicknames` and a higher rank than them.
Response `204`; members receive `guild.member_updated`, and new messages carry the nickname as
`authorNickname`. Errors: `403 missing_permission`, `403 role_hierarchy`, `404 user_not_found`.

### `POST /api/guilds/:id/invites`

Any member. Body `{ "maxUses"?: 1..1000, "expiresInSeconds"?: 60..2592000 }` (both optional;
omit for an unlimited invite). Response `201`:

```json
{
  "code": "k3Jq9_xT2a",
  "guildId": "3",
  "createdBy": "7",
  "expiresAt": null,
  "maxUses": 5,
  "uses": 0,
  "createdAt": "2026-10-22T09:15:00.000Z"
}
```

### `POST /api/guilds/:id/invites/send`

Needs `create_invites`; rate limited to 10 calls per minute per user (`429`). Body
`{ "userIds": ["8", "9"] }` (1 to 20 ids). Uses your newest never-expiring, unlimited invite for the
guild, or creates one, then opens the DM with each person and posts a message carrying an invite
card. Response `200`:

```json
{
  "code": "k3Jq9_xT2a",
  "sent": [{ "userId": "8", "channelId": "41", "messageId": "977" }],
  "skipped": [{ "userId": "9", "reason": "already_member" }]
}
```

`reason` is `already_member` or `unavailable` (yourself, a bot, an unknown id). The card is a
normal message whose first embed has `"invite": { "code": "k3Jq9_xT2a" }` plus a `title` (the
guild name) and a `description`; clients render it by calling `GET /api/invites/:code` and offer
`POST /api/invites/:code/accept`. Only the server sets `embed.invite`; webhook and bot embeds
cannot. The send path is unchanged (no extra statements).

### `GET /api/invites/:code`

Any signed-in user. Response `200`:

```json
{
  "code": "k3Jq9_xT2a",
  "guild": {
    "id": "3",
    "name": "Book club",
    "iconUrl": null,
    "accentColor": 3907271,
    "bannerUrl": "/api/attachments/<id>/banner.png",
    "description": "Tea and slow reading."
  },
  "memberCount": 4,
  "alreadyMember": false
}
```

Errors: `404 invite_not_found`, `410 invite_expired` (expired or all uses spent).

### `POST /api/invites/:code/accept`

Joins the guild. Response `200` GuildSummary. Idempotent: if you are already a member nothing
changes and no use is consumed. The use count is checked and incremented atomically, so
`maxUses` is never exceeded. After joining, fetch `GET /api/guilds/:id/channels`. Errors:
`404 invite_not_found`, `410 invite_expired`.

## Roles and permissions

How roles combine, the key list and the hierarchy are in [permissions.md](../permissions.md). Role
writes need `manage_roles` and a role strictly below your highest one (owners and instance admins are
exempt), and cannot hand out permissions you do not hold. All of these are humans-only except the
two reads.

### `GET /api/guilds/:id/roles`

Members (bots with `channels.read`). Response `200` `{ "roles": Role[] }`, highest position first,
@everyone last.

### `POST /api/guilds/:id/roles`

Body `{ "name": string (1-100), "color"?: int 0..16777215 | null, "hoist"?: boolean,
"mentionable"?: boolean, "permissions"?: string[] }`. Response `201` Role, created just above
@everyone. Errors: `400 invalid_permission` (unknown key), `403 missing_permission`, `409 too_many_roles`
(250 per server). Members receive `guild.role_created`.

### `PATCH /api/guilds/:id/roles/:roleId`

Body: any of the create fields (at least one). For @everyone only `permissions` may change
(`400 default_role`). Changing `permissions` re-evaluates who can see which channels. Response `200`
Role; members receive `guild.role_updated`. Errors: `403 role_hierarchy`, `404 role_not_found`.

### `PATCH /api/guilds/:id/roles/order`

Body `{ "roleIds": ["22", "21"] }`: every role except @everyone exactly once, highest first.
Response `200` `{ "roles": Role[] }`. Errors: `400 invalid_order`, `403 role_hierarchy`. Members receive
`guild.role_updated` for each role that moved.

### `DELETE /api/guilds/:id/roles/:roleId`

Response `204`. Holders lose it (and `guild.member_updated` is sent for each); members receive
`guild.role_deleted`. Errors: `400 default_role`, `403 role_hierarchy`, `404 role_not_found`.

### `PUT /api/guilds/:id/members/:userId/roles/:roleId` and `DELETE` (same path)

Assigns or removes a role. Idempotent, response `204`. Members receive `guild.member_updated`; users
whose channel access changed receive `channel.joined` / `channel.removed`. Errors: `400 default_role`,
`403 role_hierarchy`, `404 role_not_found`, `404 user_not_found`.

### `GET /api/guilds/:id/permissions/@me?channelId=<id>`

Members (bots with `channels.read`). What you can do, server-wide or in one channel (overwrites
applied). Response `200`:

```json
{
  "permissions": ["view_channel", "send_messages", "..."],
  "administrator": false,
  "isOwner": false,
  "topPosition": 2
}
```

For owners, instance admins and `administrator` holders `permissions` is every key and
`administrator` is `true`. `topPosition` is your highest role position, to hide controls the
hierarchy would refuse.

### `GET /api/channels/:id/overwrites`

Humans only; needs `manage_roles`. Response `200` `{ "overwrites": ChannelOverwrite[] }`.

### `PUT /api/channels/:id/overwrites/:targetType/:targetId`

`targetType` is `role` or `member`. Body `{ "allow": string[], "deny": string[] }` (replaces the
pair; both default to `[]`). Only keys marked "Channel" in the permissions table can be used. You can
allow only what you hold in that channel, and set overwrites only for roles below you or members you
outrank (yourself included). Setting a `view_channel` deny on @everyone makes the channel private
(`isPrivate`). Response `200` `{ "overwrites": ChannelOverwrite[] }` (all of the channel's).
Everyone in the channel receives `channel.overwrites_updated`; users who gain or lose access receive
`channel.joined` / `channel.removed`. Errors: `400 invalid_overwrite` (a key in both lists),
`400 invalid_permission`, `400 dm_immutable`, `403 missing_permission`, `403 role_hierarchy`,
`404 role_not_found`, `404 user_not_found`.

### `DELETE /api/channels/:id/overwrites/:targetType/:targetId`

Removes one overwrite. Same response, events and errors.

## Channels

### `GET /api/channels`

All your channels across guilds plus your DMs, with read state. Response `200`
`{ "channels": ChannelSummary[] }` (archived excluded; text channels ordered by name, DMs last).

### `GET /api/dms`

Same shape, DMs only.

### `POST /api/dms`

Body `{ "userId": "8" }`. Response `200` ChannelSummary (`kind: "dm"`, `dmUser` set). Idempotent:
the same pair always yields the same channel, whoever starts it. The other user receives
`channel.joined` the first time. Any signed-in person can be messaged; bots only when you share a
guild with them. Errors: `400` (yourself), `403` (a bot you share no guild with),
`404 user_not_found`.

### `PATCH /api/channels/:id`

Body: any of `{ "name": string, "topic": string | null, "archived": boolean, "botFeed": boolean }` (at least one).
Allowed for the channel's creator and anyone with `manage_channels` in it (the owner and instance
admins included) who is a member of the channel. Response `200` Channel. Members get `channel.updated`; archiving sends
`channel.removed` (and unarchiving `channel.joined`) to every member. Errors: `400 dm_immutable`,
`403 missing_permission`, `409 name_taken`.

`botFeed: true` puts the channel in **bot feed mode**: only bots, incoming webhooks and people with
`manage_messages` in the channel may post; everyone else gets `403 bot_feed` from every send path
(REST and `message.send`). Reactions, buttons and slash commands keep working, and the public
answer of a built-in command is still posted as the caller. `Channel` and `ChannelSummary` carry
`botFeed` and `botIds`.

### `PUT /api/channels/:id/bots`

Body `{ "botIds": string[] (<=10) }`: replaces the channel's assigned bots, in that order. Allowed
for the channel's creator and anyone with `manage_channels` (humans only). Every id must be a bot
in the channel's guild (`404 bot_not_found`). Response `200` Channel (`botIds` set); members get
`channel.updated`. Assigning grants a bot nothing: clients show the bots in the channel header and
list their slash commands first in that channel. A bot removed from the guild drops out of every
assignment and loses its schedules.

### `GET /api/channels/:id/members`

Members only. Response `200` `{ "members": DirectoryUser[] }`.

### `POST /api/channels/:id/members`

Private text channels only. Any member of the channel can add a guild member; this writes a member
overwrite allowing `view_channel`. Body `{ "userId": "8" }`.
Response `204`; the added user receives `channel.joined`. Errors: `400 public_channel`,
`400 dm_immutable`, `404 user_not_found` (not in this guild), `409 channel_archived`.

### `DELETE /api/channels/:id/members/:userId`

Private text channels only. Removing yourself is leaving. Removing others requires being the
channel creator or `manage_channels` (and a member); this writes a member overwrite denying
`view_channel`. Response `204`; the removed user receives `channel.removed` and their live
subscription ends. The owner, instance admins and holders of `administrator` cannot be removed this way: nothing can
deny them. Errors: `400 public_channel`, `400 dm_immutable`,
`403 missing_permission`.

### `POST /api/channels/:id/leave`

Shorthand for removing yourself. Response `204`. Public channels cannot be left (they follow
guild membership): `400 public_channel`; DMs cannot be left: `400 dm_immutable`.

### `POST /api/channels/:id/read`

Body `{ "messageId": "977" }` (must be a message in this channel). Moves your read marker
forward only; an older id changes nothing. Response `200`:

```json
{ "channelId": "11", "lastReadMessageId": "977", "unreadCount": 3, "mentionCount": 0 }
```

All your sessions receive `read.updated` with the same fields. Errors: `400 invalid_message`,
`403`.

## Messages

### `GET /api/channels/:id/messages?before=<id>&limit=<1..100, default 50>`

Members only. Response `200` `{ "messages": Message[], "hasMore": boolean }`: the newest
`limit` messages older than `before`, **oldest first**. Page back by passing the first returned
id as `before`. Deleted messages are included as tombstones.

### `POST /api/channels/:id/messages`

Members who hold `send_messages` in the channel (and `attach_files` when `attachmentIds` is given).
Body:

```json
{
  "content": "hello <@8>",
  "nonce": "c0ffee",
  "replyToId": "975",
  "attachmentIds": ["0b0c2d5e-6a53-4f5e-9d8e-0d6b1c1f0a11"]
}
```

`content` is trimmed, up to 4000 chars, and may be `""` only when `attachmentIds` is non-empty.
`nonce` (<=64 chars), `replyToId` and `attachmentIds` (max 10) are optional. Attachments must
be your own uploads that are not yet attached. Response `201` Message. The message is also
broadcast as `message.created` (carrying `nonce`) to subscribers, including your own sockets.
Errors: `400 invalid_reply` (not in this channel or deleted), `400 invalid_attachments`,
`403` (`forbidden` or `missing_permission`), `409 channel_archived`, `429`.

**Bot-to-bot limits.** Each message stores `hops` (not part of the `Message` JSON). A bot message that replies to another bot's message gets the parent's `hops` plus one; one that mentions another bot without replying to one gets 1; a bot answering its own message adds nothing; anything from a person or a webhook is 0. A bot message beyond `BOT_MAX_HOPS` (default 8) is refused with `429 bot_loop`, and more than `BOT_BUDGET_MAX` (30) bot-to-bot messages per channel per `BOT_BUDGET_WINDOW_SECONDS` (60) with `429 bot_budget`. Neither applies to people, and neither adds a statement to a person's send. See [the agent hub](../agents.md#agent-to-agent-safety).

### `PATCH /api/messages/:id`

Author only. Body `{ "content": "new text" }` (1-4000 chars); a bot may add `"components": null` to remove the buttons under its own message (a person sending it gets `400 components_bots_only`). Sets `editedAt`. Response `200`
Message; broadcast as `message.updated`. Newly mentioned users get a `mention`. Errors:
`403`, `404` (also for deleted messages).

### `DELETE /api/messages/:id`

The author, or anyone with `manage_messages` in the channel. Soft delete. Response `204` (also if already deleted); broadcast as
`message.deleted`.

### `PUT /api/messages/:id/reactions/:emoji` and `DELETE` (same path)

Members; adding needs `add_reactions` in the channel, removing your own reaction needs nothing.
`:emoji` is URL-encoded: a single Unicode emoji (`%F0%9F%91%8D`) or a custom
shortcode `:name:` (`^:[a-z0-9_]{2,32}:$`, encoded as `%3Aname%3A`). Response `204`; both are
idempotent. Broadcast as `reaction.added` / `reaction.removed` only when something changed.
A message holds at most 20 distinct emoji. Errors: `400 invalid_emoji`, `400 reaction_limit`,
`404`, `429`. Provided by the `reactions` module: `404 module_disabled` in guilds that switched it off.

### `PUT /api/messages/:id/pin` and `DELETE /api/messages/:id/pin`

Needs `manage_messages` or `pins.pin` in the channel (@everyone has `pins.pin` by default). Response
`200` Message (with `pinnedAt`/`pinnedBy` set or cleared). Broadcast as
`message.updated` when it changed.

### `GET /api/channels/:id/pins`

Members only. Response `200` `{ "messages": Message[] }`, newest pin first, at most 50.
Pinning is provided by the `pins` module: `404 module_disabled` in guilds that switched it off.

## Panels and buttons

A panel is a declarative JSON view that a bot publishes into a channel. Harmony renders it itself
with theme tokens; a view never carries HTML, CSS, scripts or URLs for styling. A guild channel of
kind `dashboard` shows its panels instead of a message list; in a text channel the pinned panels sit
in a strip above the messages. Guide with examples: [integrations](../integrations.md#panels-and-buttons).

`Panel` = `{id, channelId, botId, key, view, version, pinned, position, createdAt, updatedAt}`.
`version` starts at 1 and grows with every change. `PanelView` = `{title?: string (<=100), blocks: Block[] (1..24)}`,
the whole view at most 64 KiB serialized. Every block has an optional `id` (slug, unique in the view)
and `span` (`1`, `2` or `"full"`). Block types: `stat`, `chart`, `table`, `status`, `progress`, `kv`,
`markdown` and `actions`; the limits are in `PANEL_LIMITS` in
[`panels.ts`](../../packages/shared/src/panels.ts). A `Button` = `{id (slug), label (<=40), style?: primary | secondary | danger, confirm?: {title, body?, confirmLabel?}, requiredPermission?: <permission key>}`.

### Bot endpoints (scope `panels.write`)

The bot must be in the guild and may send messages in the channel (`send_messages`); it is the only
writer of its own panels. People get `403 bots_only`. Per-bot limit: `PANEL_RATE_MAX` writes per
`PANEL_RATE_WINDOW_SECONDS` (10 per second), then `429` with `Retry-After`.

| Endpoint                                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUT /api/channels/:id/panels/:key`         | Body `{view, pinned?}`. Creates or replaces the bot's panel `key` (a slug); `200 Panel`, version +1. At most 20 panels per channel (`409 panel_limit`).                                                                                                                                                                                                                                    |
| `POST /api/channels/:id/panels/:key/points` | Body `{blockId, series, points: [{x, y}] (1..100)}`. Appends to a series of the chart block `blockId` (the series is created if the chart has room), keeps the newest 500 points per series, and drops the oldest points of the longest series if the view would pass 64 KiB. Done under a row lock, so concurrent appends do not lose points. `400 invalid_chart`, `404 panel_not_found`. |
| `DELETE /api/channels/:id/panels/:key`      | `204`; `panel.deleted` follows.                                                                                                                                                                                                                                                                                                                                                            |

### User endpoints

| Endpoint                       | Behavior                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/channels/:id/panels` | `{panels: Panel[]}` in display order; needs membership of the channel (`view_channel`). Bots with `channels.read` may read too. |
| `PATCH /api/panels/:panelId`   | `{pinned}`; `manage_channels` or the channel's creator.                                                                         |
| `DELETE /api/panels/:panelId`  | Same rule; `204`.                                                                                                               |

### Frames

Published on the channel topic through Redis like messages, so sockets subscribed to the channel
get them on every instance.

```json
{ "type": "panel.updated", "channelId": "11", "panel": { "id": "4", "key": "host", "version": 7 } }
{ "type": "panel.deleted", "channelId": "11", "panelId": "4" }
```

Rows are written at once; only the frame is coalesced. Per panel and per server instance, the first
change in a window is sent immediately and later changes in the window are held and sent as one
frame carrying the newest version when the window ends (`PANEL_COALESCE_MS`, default 1000, `0`
turns it off). Clients ignore a frame whose `version` is not above the one they hold, and refetch
the panels they have cached after a reconnect.

### Buttons

`POST /api/interactions/actions` (humans only; also the `action.invoke` frame) takes
`{source: {panelId} | {messageId}, actionId, nonce?}` and answers `202 {interactionId}`. The server
checks, in order: the rate limit (`ACTION_RATE_MAX` per `ACTION_RATE_WINDOW_SECONDS`), that the
panel or message exists, that the caller is in the channel and may `view_channel`, that the button
exists **in the current version** of the panel or message (`404 unknown_action`), and the button's
`requiredPermission` if any (`403 missing_permission`). It then stores an `interactions` row with
`type = 'action'` and calls the bot's interactions URL exactly as for a command (signed, 3 s
deadline, deferred answers and follow-ups through the interaction token). The bot needs the
`commands` scope for the URL to be accepted.

Bots attach buttons to messages with `components: {buttons: Button[] (1..5)}` on
`POST /api/channels/:id/messages` and in interaction answers and follow-ups. People get
`400 components_bots_only`; the field is on `Message` as `components`.

`InteractionPayload` is a union on `type`. `command` is unchanged. For `action`:

```json
{
  "id": "5",
  "token": "…",
  "type": "action",
  "action": { "id": "restart", "source": { "kind": "panel", "panelId": "4", "key": "host" } },
  "guildId": "1",
  "channelId": "11",
  "user": { "id": "7", "login": "ada@example.com", "displayName": "Ada" },
  "createdAt": "…",
  "expiresAt": "…"
}
```

`source` is `{ "kind": "message", "messageId": "…" }` for a button under a message. The bot answers
with `message` (ephemeral allowed), `deferred`, or `{ "type": "update_panel", "view": PanelView }`,
which replaces the panel it owns (valid only for panel buttons; the view is validated like a PUT).
The caller's socket then gets `interaction.ephemeral`, `interaction.pending` or `interaction.failed`
(with `kind: "action"`, and `command` set to the button's label), or `interaction.completed`
(`{interactionId, channelId, nonce?}`) after a public message or a panel update, so a button can
stop its spinner; all carry the click's `nonce`.

## Scheduled refreshes

A bot registers schedules and Harmony calls it when they fall due, so a dashboard can refresh
without the bot keeping its own timer. Guide: [integrations](../integrations.md#scheduling-refreshes).

`Schedule` = `{rowId, id, botId, guildId, channelId, every, cron, panelKey, paused, nextRunAt, lastRunAt, lastStatus, lastError}`;
`id` is the bot's own slug for it, `every` seconds or `cron` is set (never both), `lastStatus` is
`ok`, `failed` or `skipped`.

| Endpoint                            | Behavior                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/bots/@me/schedules`       | Bot token with the `commands` scope (that scope is what lets a bot receive interactions at all). Body `{schedules: [{id, channelId, every \| cron, panelKey?}]}` replaces the bot's schedules, like commands: entries left out are removed. `every` is 60 to 86400 seconds (`SCHEDULE_MIN_EVERY_SECONDS` lowers the floor), `cron` five UTC fields. Response `{schedules: Schedule[]}`. People get `403 bots_only`. |
| `GET /api/bots/@me/schedules`       | The bot's own schedules.                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/channels/:id/schedules`   | Schedules targeting the channel; needs the channel's creator or `manage_channels` (humans only).                                                                                                                                                                                                                                                                                                                    |
| `PATCH /api/schedules/:scheduleId`  | `{paused}`; same rule. Resuming starts a fresh period.                                                                                                                                                                                                                                                                                                                                                              |
| `DELETE /api/schedules/:scheduleId` | `204`; same rule. The bot's next `PUT` recreates it, so pause is the lasting control.                                                                                                                                                                                                                                                                                                                               |

Errors on `PUT`: `400 schedule_too_frequent`, `400 duplicate_schedule`, `400` for a bad cron
expression, a value outside the range or both/neither of `every` and `cron`;
`409 bot_not_in_channel` (the bot must be a member of every target channel, which must be a
non-archived guild channel); `409 schedule_limit` (at most 20 per bot per guild). A schedule that
keeps its channel and cadence on re-registration keeps its next run and its paused flag.

### The `refresh` interaction

When a schedule is due, the bot gets an interaction of `type: "refresh"` over the same path as a
command: a signed POST to its interactions URL, or an `interaction.create` frame on its gateway
connection if it has none. The body has no `user`:

```json
{
  "id": "9",
  "token": "…",
  "type": "refresh",
  "schedule": { "id": "host-panel", "channelId": "11", "panelKey": "host" },
  "guildId": "1",
  "channelId": "11",
  "createdAt": "…",
  "expiresAt": "…"
}
```

The deadline (3 s) and the token (valid 15 minutes for follow-ups) are the same as for a command.
Answers: `{"type": "update_panel", "view": …}` replaces the panel `panelKey` of this bot in the channel
(needs a `panelKey`, and the panel must exist: `post_failed` otherwise); `{"type": "message", …}`
is posted as the bot (`ephemeral` is refused, there is nobody to show it to); `{"type": "deferred"}`
means the bot answers through the panel API or a follow-up later. Anything else, a non-2xx status,
a timeout or an offline gateway bot is recorded in `lastStatus: "failed"` with the reason in
`lastError` (`timeout`, `unreachable`, `bad_status`, `invalid_response`, `blocked_url`,
`post_failed`, `bot_unavailable`).

### How runs are claimed

Every app instance runs a scheduler (`SCHEDULER_TICK_MS`, default 5000, `0` turns it off). A tick
claims due rows with `FOR UPDATE SKIP LOCKED` and in the same short transaction moves
`next_run_at` ahead (the period counts from now plus jitter of up to 10 percent, at most 5 s; cron
adds under 2 s) and sets `pending_until` to the interaction deadline plus 5 s. Another instance, or
the next tick, therefore finds nothing due. If the bot's previous run is still pending when a
schedule falls due again, that run is skipped (`lastStatus: "skipped"`) and the next one is
scheduled normally. A crashed instance leaves a marker that expires on its own. Missed periods are
not replayed: after downtime a schedule runs once.

## Profiles, custom emoji and perks

```ts
ProfileSummary = { accentColor: int|null, statusEmoji: string|null, statusText: string|null,
                   statusExpiresAt: iso|null, hasPerks: boolean }
Profile        = ProfileSummary & { userId, avatarUrl, providerAvatarUrl, avatarOverridden,
                   bannerUrl, bannerColor: int|null, bio: string|null, pronouns: string|null,
                   perks: Perk[] }   // perks = explicit grants only
Perk           = "animated_avatar" | "profile_banner_image" | "cross_server_emoji"
               | "larger_uploads" | "extra_themes" | "custom_status_emoji"
GuildEmoji     = { id, guildId, name, animated, url, createdBy, createdByName, createdAt }
```

### `GET /api/users/:id/profile?guildId=<id>`

Response `200` `{ profile: Profile, displayName, login, createdAt, member: { nickname, joinedAt,
roleIds } | null }`. `member` is filled when `guildId` is given and both of you are in it.
`404 user_not_found` unless you are that user or share a guild or a DM with them. An expired
status is cleared on read.

### `PATCH /api/me/profile`

Humans only. Body (every field optional, `null` clears): `avatarAttachmentId`,
`bannerAttachmentId`, `bannerColor` and `accentColor` (0..16777215), `bio` (at most 190
characters, rendered with the message Markdown subset), `pronouns` (at most 40), and
`status: { emoji, text (at most 128), duration: "30m"|"1h"|"4h"|"today"|"never", tzOffsetMinutes? } | null`.
Attachments must be your own unattached uploads. Response `204`.

- A `null` `avatarAttachmentId` removes the override and restores the Tailscale picture.
- `403 perk_required` for an animated avatar without `animated_avatar`, a banner image without
  `profile_banner_image`, or a custom emoji in the status without `custom_status_emoji` (and
  membership of the emoji's server).
- `400 avatar_too_large` over 8 MB.

### `GET /api/me/emoji`

`{ emoji: (GuildEmoji & { usable })[] }`: the emoji of every server you are in. `usable` says
whether you may use it outside its own server (the cross-server perk).

### `GET /api/guilds/:id/emoji`, `POST`, `PATCH /api/guilds/:id/emoji/:emojiId`, `DELETE`

Module `custom-emoji` (404 `module_disabled` when switched off). `GET` needs membership; the
others need `manage_emoji`. `POST` takes `{ name, attachmentId }` with `name` matching
`^[a-z0-9_]{2,32}$`, unique per server. The upload (via `POST /api/uploads`) must be a PNG, GIF
or WebP of at most 256 KB and 128x128 pixels, else `400 invalid_emoji_image | emoji_too_large |
emoji_dimensions`. `409 emoji_name_taken`, `409 emoji_limit` (`EMOJI_MAX_PER_GUILD`, default 50).
`animated` is true for GIFs with more than one frame and for animated WebP.

### `GET /api/emoji/:emojiId/:filename`

The image, readable by any signed-in user (a message in any server may show it). Same safe
headers as attachments.

### Message tokens

`<:name:id>` and `<a:name:id>` (animated) in message content. On send and edit the server
resolves each token with an in-process cache (no query per message): unknown ids, emoji of a
server with the module off, and emoji the sender may not use become plain `:name:` text, and a
stale `name` is replaced by the real one. An emoji is usable when it belongs to the message's
server, or the sender has `cross_server_emoji` and is a member of the emoji's server. Reactions
take the same token as the `:emoji` path segment (URL-encoded); an unusable one is
`400 emoji_unavailable`. Unicode and legacy `:shortcode:` reactions are unchanged.

### Perks

Free, admin-granted entitlements. Everyone has the `PERKS_DEFAULT` set (`all` by default;
`none` or a comma list restricts it) plus their explicit grants.

- `GET /api/me/perks` -> `{ perks: Perk[], explicit: Perk[] }`.
- `GET /api/admin/perks` -> `{ defaults, all, users: [{ id, login, displayName, grants: [{ perk, grantedBy, grantedByName, grantedAt }] }] }`.
- `PUT /api/admin/users/:userId/perks` with `{ perk }`, `DELETE /api/admin/users/:userId/perks/:perk`: `204`.

The admin endpoints answer `403` to anyone who is not an instance admin. Enforcement: avatar
and banner (`PATCH /api/me/profile`), uploads (`POST /api/uploads` limit `UPLOAD_MAX_BYTES`, or
`UPLOAD_MAX_BYTES_PERK` with `larger_uploads`, default 50 MiB), the custom theme limit (20, or
100 with `extra_themes`), cross-server emoji in messages and reactions, and status emoji.

## Search

### `GET /api/search?q=<text>&channelId=<id>&before=<id>&limit=<1..100, default 50>`

Full-text search over messages in channels you belong to, newest first, excluding deleted
messages. `q` (1-200 chars) uses web-search syntax: words are ANDed, `"quoted phrases"`, `or`,
and `-exclude` work. Matching is on whole words with no stemming. `channelId` narrows to one
channel (not a member: empty result). Page by passing the last returned id as `before`.
Response `200` `{ "messages": Message[], "hasMore": boolean }` (newest first, unlike history).
Provided by the `search` module: guilds that switched it off are left out of the results.

## Modules

Features beyond the core are modules (see [docs/modules.md](../modules.md)). Each server can switch
optional modules off; the instance can switch any off with `MODULES_DISABLED`.

### `GET /api/guilds/:id/modules`

Members (bots with `channels.read`). `{modules: [GuildModule]}` for every module the instance runs:

```json
{
  "id": "polls",
  "name": "Polls",
  "description": "Ask a question and let people vote...",
  "optional": true,
  "enabled": true,
  "dependsOn": [],
  "settings": { "allowMultipleChoice": true },
  "settingsSchema": {
    "type": "object",
    "properties": {
      "allowMultipleChoice": {
        "type": "boolean",
        "default": true,
        "title": "Allow multiple choice"
      }
    }
  },
  "permissions": [{ "key": "polls.create", "description": "Create polls" }]
}
```

`settingsSchema` is a JSON Schema (or `null`) that a client can turn into a form. `permissions` are
the keys the module defines; roles can hold them and the module enforces them (see
[permissions.md](../permissions.md#module-permissions)).

### `PUT /api/guilds/:id/modules/:moduleId`

Humans only; needs `manage_guild`. Body `{enabled?, settings?}` (at least one).
`settings` is merged into the current settings and validated against the module's schema. Returns the
updated `GuildModule`. Errors: `400 invalid_settings`, `404 module_not_found`, `409 module_required`
(not optional), `409 dependency_disabled`, `409 module_in_use`.

Every member is sent `guild.modules_updated` (below). A disabled module's routes answer
`404 module_disabled` for that guild, its slash commands disappear from autocomplete, and its
built-in commands stop running there. Data already stored is kept.

### Module frames

Modules add WebSocket frames named `<moduleId>.<name>`; ids that start a core frame (`message`,
`reaction`, `guild`, `channel`, `read`, `presence`, `interaction`, ...) are reserved. Server-to-client
module frames travel on the same channel and user topics as core events. A client that does not know
a module ignores its frames. Client-to-server module frames are validated by the module; a malformed
or unknown one gets `invalid_frame`. Bots may send a module frame only if the module names a scope
for it and the bot holds it.

### Polls

A poll is a message whose `modules.polls` holds the tallies; its `content` is the question.

```json
{
  "multiple": false,
  "closed": false,
  "closedAt": null,
  "totalVoters": 3,
  "options": [
    { "id": 1, "label": "Pizza", "votes": 2, "voterIds": ["7", "8"] },
    { "id": 2, "label": "Ramen", "votes": 1, "voterIds": ["9"] }
  ]
}
```

`totalVoters` counts distinct people and is the denominator for percentages. `voterIds` lists everyone
who voted for the option (polls are not anonymous).

| Endpoint                                                        | Notes                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/channels/:id/polls` `{question, options, multiple?}` | Scope `messages.write`. 1 to 300 characters of question, 2 to 10 different options of up to 100 characters. `201` with the `Message`. `400 multiple_choice_disabled` if the server turned it off. |
| `GET /api/polls/:id`                                            | `:id` is the message id. Scope `messages.read`. `200` with the `Poll`.                                                                                                                            |
| `PUT /api/polls/:id/votes` `{optionIds}`                        | Scope `messages.write`. Replaces your votes; `[]` retracts them. One id on a single-choice poll (`400 single_choice`), `400 invalid_option`, `409 poll_closed`. Returns the `Poll`.               |
| `POST /api/polls/:id/close`                                     | Scope `messages.write`. Author only (`403`). Idempotent. Returns the `Poll`.                                                                                                                      |

Server to client, on the channel topic: `{"type":"polls.updated","channelId","messageId","poll"}`
after every vote and when a poll closes. Client to server: `{"type":"polls.vote","messageId","optionIds"}`
(scope `messages.write` for bots), the WebSocket twin of the vote endpoint; failures arrive as
`error` frames. The built-in command `/poll question:<text> options:<a|b|c> [multiple:<true|false>]`
creates a poll as the caller.

## Uploads

### `POST /api/uploads`

`multipart/form-data` with exactly one file field (any field name). Optional query `?channelId=<id>`:
when given, you must hold `attach_files` there (`403 missing_permission`) so a refused upload fails
before the bytes are stored; sending the message always checks it again. Limits: 10 MiB by default
(`UPLOAD_MAX_BYTES`), per-user rate limit. The file type is detected from its content; the
declared type and name are not trusted. Response `201` Attachment (`width`/`height` are set for
png, jpeg, gif and webp, else `null`):

```json
{
  "id": "0b0c2d5e-6a53-4f5e-9d8e-0d6b1c1f0a11",
  "filename": "cat.png",
  "contentType": "image/png",
  "sizeBytes": 20481,
  "width": 640,
  "height": 480,
  "url": "/api/attachments/0b0c2d5e-6a53-4f5e-9d8e-0d6b1c1f0a11/cat.png"
}
```

Errors: `400 no_file`, `400 empty_file`, `400 invalid_request` (not multipart),
`413 file_too_large`, `429`. Files larger than about 11 MB are refused by the proxy with a
plain `413` before reaching the app. Uploads not attached to a message within 24 hours are
deleted. Use the returned `id` in `attachmentIds`, or as a guild `iconAttachmentId`.

### `GET /api/attachments/:id/:filename`

Streams the file. Allowed for members of the message's channel; before it is attached, only the
uploader; guild icons are visible to any signed-in user. `:filename` is cosmetic. Response
headers: `Content-Type` (detected), `X-Content-Type-Options: nosniff`,
`Content-Disposition: inline` for png/jpeg/gif/webp and `attachment` for everything else
(including SVG and HTML), `Content-Security-Policy: default-src 'none'; sandbox`,
`Cache-Control: private, max-age=31536000, immutable`. Errors: `403`, `404`
(unknown, or its message was deleted).

## WebSocket

Connect to `/api/ws` (same origin; the upgrade is authenticated and Origin-checked like REST).
Frames are JSON text, at most 16 KiB. On a malformed frame the server replies
`{"type":"error","code":"invalid_frame",...}` and keeps the socket open.

Order of events after connecting: the server sends `hello`; the socket is then live for your
per-user events (`channel.*`, `guild.*`, `read.updated`, `mention`) and for `presence.batch`
about people who share a guild or DM with you. Channel events (messages, reactions, typing) arrive only for channels you have
subscribed to. After a reconnect: re-fetch `GET /api/presence` (after `hello`), `GET /api/guilds` and
`GET /api/channels`, and re-`subscribe` with `lastSeenId`.

**Flood protection**: each socket has a token bucket of 30 frames, refilled at 3 per second.
Frames beyond it are dropped with `{"type":"error","code":"rate_limited"}`; after 100 dropped
frames the server closes the socket with code 1008. Typing pings are further throttled
(below).

### Client to server

| `type`              | Fields                                                          | Effect                                                                                                                         |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `subscribe`         | `channelId`, `lastSeenId?`                                      | Start receiving the channel's events. Members only. Answered with `backfill`.                                                  |
| `unsubscribe`       | `channelId`                                                     | Stop receiving. No reply.                                                                                                      |
| `message.send`      | `channelId`, `content`, `nonce`, `replyToId?`, `attachmentIds?` | Same rules as `POST /messages`. Answered with `ack` (to you) and `message.created` (to subscribers). `nonce` is required here. |
| `read`              | `channelId`, `messageId`                                        | Same as `POST /channels/:id/read`. Answered with `read.updated` to all your sessions.                                          |
| `typing`            | `channelId`                                                     | Relays `typing` to subscribers. Members only; ignored if you sent one for this channel in the last 2 seconds.                  |
| `presence.set`      | `status` (`online`, `idle`, `dnd`, `invisible`)                 | Same as `PATCH /api/me`. No reply.                                                                                             |
| `presence.activity` | `idle` (boolean)                                                | This socket's own idleness; see Presence. No reply. Humans only.                                                               |
| `action.invoke`     | `source` (`{panelId}` or `{messageId}`), `actionId`, `nonce?`   | Press a button (humans only); same as `POST /api/interactions/actions`. See Panels and buttons.                                |
| `command.invoke`    | `channelId`, `name`, `options?`, `nonce?`                       | Run a slash command (humans only); the outcome arrives as a message or an `interaction.*` frame. See Slash commands.           |

```json
{ "type": "subscribe", "channelId": "11", "lastSeenId": "980" }
{ "type": "message.send", "channelId": "11", "content": "hi", "nonce": "c0ffee",
  "replyToId": "975", "attachmentIds": [] }
{ "type": "read", "channelId": "11", "messageId": "981" }
{ "type": "typing", "channelId": "11" }
{ "type": "presence.set", "status": "idle" }
```

Failures arrive as `error` frames (below); `message.send` failures echo the `nonce`.
Non-members get `{"type":"error","code":"forbidden",...}` for `subscribe`, `message.send`,
`read` and `typing`. `message.send` without `send_messages` answers `missing_permission` (with the
nonce); a `typing` frame without it is dropped silently.

### Server to client

**Connection and request replies**

```json
{ "type": "hello", "user": { "...Me": "..." }, "instanceId": "app-1" }
{ "type": "ack", "nonce": "c0ffee", "message": { "...Message": "..." } }
{ "type": "error", "code": "forbidden", "message": "You are not a member of this channel", "nonce": "c0ffee" }
{ "type": "backfill", "channelId": "11", "messages": [ { "...Message": "..." } ], "hasMore": false }
```

`error.nonce` is present only for failed `message.send`. `backfill` is always the
confirmation that a `subscribe` is live: messages newer than `lastSeenId` (oldest first, at
most 200) or empty when none was given. With `hasMore: true`, discard your cache for the
channel and reload the newest page over REST. Messages can appear both live and in the
backfill; dedupe by id. Backfill also returns tombstones, but it cannot tell you about deletes,
edits or reactions that happened to messages you already had: reload visible history after a
long disconnect if that matters.

**Channel events** (only for subscribed channels)

```json
{ "type": "message.created", "message": { "...Message": "..." }, "nonce": "c0ffee" }
{ "type": "message.updated", "message": { "...Message": "..." } }
{ "type": "message.deleted", "channelId": "11", "messageId": "981" }
{ "type": "reaction.added", "channelId": "11", "messageId": "981", "emoji": "👍", "userId": "8" }
{ "type": "reaction.removed", "channelId": "11", "messageId": "981", "emoji": "👍", "userId": "8" }
{ "type": "typing", "channelId": "11", "userId": "8" }
```

- `message.created.nonce` is present only if the sender supplied one; match it to your
  optimistic copy.
- `message.updated` carries the full message and is sent for edits and pin changes. Replace
  your copy by id.
- `typing` is ephemeral and never stored. Show the indicator for about 6 seconds
  (`TYPING_EXPIRY_MS`) after the last ping, and clear it when that user's message arrives. You
  also receive your own pings; ignore them.
- Losing access to a channel (removed, left, guild left) ends its subscription server-side.

**Per-user events** (all your sessions, no subscription needed)

```json
{ "type": "channel.joined", "channel": { "...ChannelSummary": "..." } }
{ "type": "channel.removed", "channelId": "11" }
{ "type": "channel.updated", "channel": { "...Channel": "..." } }
{ "type": "read.updated", "channelId": "11", "lastReadMessageId": "981", "unreadCount": 0, "mentionCount": 0 }
{ "type": "mention", "channelId": "11", "messageId": "981" }
{ "type": "guild.joined", "guild": { "...GuildSummary": "..." } }
{ "type": "guild.updated", "guild": { "...Guild": "..." } }
{ "type": "settings.updated", "settings": { "...UserSettings": "..." } }
{ "type": "themes.updated", "themes": [{ "...CustomTheme": "..." }] }
{ "type": "guild.removed", "guildId": "3" }
{ "type": "guild.member_joined", "guildId": "3", "user": { "...DirectoryUser": "..." } }
{ "type": "guild.member_left", "guildId": "3", "userId": "8" }
{ "type": "guild.role_created", "guildId": "3", "role": { "...Role": "..." } }
{ "type": "guild.role_updated", "guildId": "3", "role": { "...Role": "..." } }
{ "type": "guild.role_deleted", "guildId": "3", "roleId": "21" }
{ "type": "guild.member_updated", "guildId": "3", "userId": "8", "roleIds": ["21"], "nickname": "Ada L." }
{ "type": "channel.overwrites_updated", "channelId": "11", "overwrites": [ { "...ChannelOverwrite": "..." } ] }
{ "type": "guild.modules_updated", "guildId": "3", "moduleId": "polls", "enabled": false, "settings": { "allowMultipleChoice": true } }
{ "type": "user.updated", "user": { "...DirectoryUser": "..." }, "profile": { "...ProfileSummary": "..." } }
{ "type": "guild.emoji_updated", "guildId": "3", "emoji": [ { "...GuildEmoji": "..." } ] }
{ "type": "interaction.ephemeral", "interactionId": "5", "channelId": "11", "command": "echo", "botId": "9", "content": "only you", "nonce": "abc" }
{ "type": "interaction.pending", "interactionId": "5", "channelId": "11", "command": "roll", "botId": "9", "expiresAt": "2026-10-22T09:30:00.000Z", "nonce": "abc" }
{ "type": "interaction.failed", "interactionId": "5", "channelId": "11", "command": "roll", "botId": "9", "reason": "timeout", "nonce": "abc" }
```

- `user.updated` goes to the user and everyone who shares a guild or a DM with them, after a
  change to their avatar, accent color or custom status (and when a status expires). One query finds
  the audience and the publishes are pipelined in batches of 500, so the cost is a few Redis round
  trips, not one per recipient. It carries only the summary; clients fetch the full profile on demand
  when a profile card opens. `guild.emoji_updated` carries the server's whole emoji list and goes to
  every member.
- `channel.joined` is sent when a channel appears for you: you were added to a private channel,
  a public channel was created in one of your guilds, a DM was opened with you, a channel was
  unarchived. `channel.removed` is the reverse (removed, left, archived, guild left or deleted).
  Add or drop the sidebar entry and its subscription.
- On `guild.joined` fetch `GET /api/guilds/:id/channels` for the guild's channels.
- `botId` in `interaction.*` frames is `null` for built-in commands, which add `source` (the module's
  name).
- `guild.role_*` and `guild.member_updated` go to every member of the guild; `roleIds` there is the
  member's full role set (without @everyone). A client recomputes what it shows from these and
  from `GET /api/guilds/:id/permissions/@me`, which stays the authority: the server checks every
  request itself. `channel.overwrites_updated` goes to the channel's members (it is not sent to people
  who just lost access; they get `channel.removed`).
- Access changes always arrive as `channel.joined` / `channel.removed`, whatever caused them (a role
  change, an overwrite, a kick): add or drop the sidebar entry and subscription.
- `guild.modules_updated` is sent to every member of the guild when a module is switched or its settings
  change. Update the cached state and show or hide that module's UI.
- `mention` means someone mentioned you in a message or edit (never your own). Combine with
  `read.updated` counts for badges.

**Presence** (only about users who share a guild or a DM with you)

```json
{
  "type": "presence.batch",
  "updates": [
    { "userId": "8", "status": "online" },
    { "userId": "9", "status": "offline" }
  ]
}
```

`status` is `online`, `idle`, `dnd` or `offline`. An `invisible` user is reported as `offline`.
Changes are coalesced per guild or DM over a window (`PRESENCE_BATCH_MS`, default 1000 ms) and
sent as one frame: within the window the last state per user wins, updates are in the order of
their last change, and a user whose final state equals what the topic last sent is left out, so a
quick disconnect and reconnect sends nothing. A frame has at most 500 updates; a burst larger
than that arrives as several frames in the same tick. A change is therefore seen up to one
window late. It is produced when a user's first connection opens, their last one closes or
times out (up to about 2 minutes after a crash), or they change their status.

**Chosen status and automatic idle.** `presence.set` and `PATCH /api/me` set the chosen status
(`online`, `idle`, `dnd`, `invisible`), which is stored and survives reconnecting. Automatic
idleness is separate, per socket and never stored: a client sends `presence.activity` with
`idle: true` after its own quiet time (the web app also counts a hidden tab) and `idle: false` on
the next interaction, only when that flag changes. A user whose chosen status is `online` is shown
as `idle` when every connected socket is idle, and as `online` as soon as any one is active; any
other chosen status is shown as it is whatever the sockets report. A new socket starts active, so
a client that is idle after reconnecting sends `idle: true` again; closed and timed-out sockets
stop counting. `GET /api/me` always returns the chosen status, never the automatic idle. Older
clients that send `presence.set` with `idle` keep working: that is a chosen idle, as before.

Who can see whom follows membership live: joining a guild or getting a DM starts delivery (and
the others learn how you are doing), leaving, being kicked or deleting stops it, all without
reconnecting. The server does not push a snapshot when that happens; fetch `GET /api/presence`
on `guild.joined`, `guild.removed`, `guild.member_left` and a `channel.joined` for a DM. The old
`presence.updated` frame, which went to every connected socket, no longer exists.

## Bots and integrations

Bots are users (`kind: "bot"`, `isBot: true` on `User`), so every membership and permission
rule above applies to them unchanged. They use this same REST API and the `/api/ws` gateway.
Design rationale and the threat model are in `docs/security/trust-model.md`.

### Authentication

```
Authorization: Bot hb_<botId>_<43 base64url characters>
```

- A request with an `Authorization: Bot` header is authenticated by the token alone. Every
  `Tailscale-*` header, the proxy secret and the `Origin` check are ignored for it, so a bot can
  call the app from any process that can reach it (for example through the host-local ingress on
  `127.0.0.1:8471`). A wrong token is `401 invalid_token`; the request never falls back to a
  human identity.
- The token is shown once, when the bot is created or the token is rotated, and only a SHA-256
  hash is stored. Rotating (`POST /api/bots/:id/token`) revokes the previous token immediately.
- **Scopes** are chosen per bot: `messages.read`, `messages.write`, `reactions.write`,
  `channels.read`, `commands`, `events`, `panels.write`. A route needs one scope; without it the answer is
  `403 missing_scope`. Humans are never subject to scopes.

| Scope             | Allows                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `messages.read`   | `GET` messages, pins, search, attachments; `subscribe` on the gateway                                          |
| `messages.write`  | send, edit, delete, pin messages (REST and `message.send`); `typing`                                           |
| `reactions.write` | add and remove reactions                                                                                       |
| `channels.read`   | `GET /api/guilds`, guild channels and members, `/api/channels`, channel members, `/api/users`, `/api/presence` |
| `commands`        | register slash commands (`PUT .../commands`); list a guild's commands; required to set `interactionsUrl`       |
| `events`          | required to set `eventsUrl` / `eventTypes`; message and reaction events additionally require `messages.read`   |

- Human-only endpoints answer bots with `403 human_only`: bot management, creating, changing
  and deleting guilds, channel management, invites, uploads, DMs, read markers, `PATCH /api/me`,
  webhook management and command invocation. Any route without a declared bot scope is closed
  to bots by default (`403 bot_not_allowed`).
- Bots only see what a member sees: a bot that is not in a guild gets `403 forbidden` for it.
- Each bot has its own HTTP rate-limit bucket (`BOT_RATE_LIMIT_MAX` per minute, default 600),
  separate from human users. Message and reaction limits apply as for users.
- On the gateway, send the header on the upgrade request. Frames are checked against scopes:
  `subscribe` needs `messages.read`, `message.send` and `typing` need `messages.write`;
  `read`, `presence.set` and `command.invoke` are human-only (`error` frame, `human_only`).

### Bot management (humans only)

| Endpoint                                              | Notes                                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/bots`                                      | `{name, scopes?, interactionsUrl?, eventsUrl?, eventTypes?}` returns `201 {bot, token, signingSecret}`. Both secrets are shown only here. At most 20 bots each. |
| `GET /api/bots`                                       | Your bots: `{bots: Bot[]}`.                                                                                                                                     |
| `GET /api/bots/:id`, `PATCH /api/bots/:id`            | Update `name`, `scopes`, `interactionsUrl` (nullable), `eventsUrl` (nullable), `eventTypes`.                                                                    |
| `DELETE /api/bots/:id`                                | `204`. Revokes the token, removes the bot from every guild; its past messages stay.                                                                             |
| `POST /api/bots/:id/token`                            | `{token}`; the old token stops working immediately.                                                                                                             |
| `POST /api/bots/:id/signing-secret`                   | `{signingSecret}`; takes effect immediately for new requests.                                                                                                   |
| `POST /api/guilds/:id/bots` `{botId}`                 | `204`. You must own the bot and hold `manage_guild` in the guild. Creates a normal guild membership.                                                            |
| `DELETE /api/guilds/:id/bots/:botId`                  | `204`. The guild's manager or the bot's owner.                                                                                                                  |
| `GET /api/bots/:id/deliveries?status=&before=&limit=` | Event delivery log, newest first: `{deliveries: Delivery[]}`.                                                                                                   |
| `POST /api/bots/:id/deliveries/:deliveryId/redeliver` | `202`. Resets attempts and queues the delivery again.                                                                                                           |

`Bot` = `{id, name, avatarUrl, ownerId, scopes, interactionsUrl, eventsUrl, eventTypes, delivery, createdAt, lastUsedAt}`.
`interactionsUrl` requires the `commands` scope; `eventsUrl` and `eventTypes` require `events`.
If `eventsUrl` is set without `eventTypes`, all event types are subscribed. A bot without a URL
gets that half over the WebSocket instead; see [Gateway bots](#gateway-bots-no-url). `delivery` is
`{interactions, events}`, each `http`, `gateway` or `off` (no scope, or no event types).

URLs must be `http` or `https` and are checked when saved and again on every request: addresses
in private, loopback, link-local, CGNAT (100.64.0.0/10, which covers tailnet addresses),
multicast and reserved ranges are refused with `400 url_not_allowed`. Bots owned by an instance
admin may reach hosts listed in `OUTBOUND_PRIVATE_ALLOWLIST`. Redirects are never followed.

### Gateway bots (no URL)

A bot does not need a reachable URL. If it has the `commands` scope and **no** `interactionsUrl`, its
slash commands and button clicks go to its WebSocket connection; if it has the `events` scope, event
types and **no** `eventsUrl`, its events do. `Bot.delivery` says which: `{interactions, events}`, each
`http`, `gateway` or `off`. Setting a URL switches that half back to signed HTTP; nothing else about the
bot changes, and the two halves are independent.

Connect to `GET /api/ws` with `Authorization: Bot <token>` (through the integration ingress if the bot
runs outside the tailnet). A bot with `commands` or `events` is registered as a gateway receiver once
`hello` has been sent; a bot with neither (a plain chat bot) is not. Frames are the ordinary JSON
frames of this protocol.

| Direction | Frame                                                  | Scope      | Meaning                                                                                                                                 |
| --------- | ------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| server    | `interaction.create {interaction}`                     | `commands` | `interaction` is the same `InteractionPayload` an HTTP bot gets, including `id` and `token`.                                            |
| bot       | `interaction.respond {interactionId, token, response}` | `commands` | `response` is an `InteractionResponse`: `message`, `deferred` or `update_panel`. Answer within `INTERACTION_DEADLINE_MS` (default 3 s). |
| server    | `event {seq, deliveryId, event}`                       | `events`   | `event` is the `EventEnvelope` an HTTP bot would get; `seq` is per bot, starts at 1 and only grows; `deliveryId` is the idempotency id. |
| bot       | `event.ack {seq}`                                      | `events`   | Everything up to and including `seq` is handled.                                                                                        |
| bot       | `resume {lastSeq}`                                     | `events`   | Send after every reconnect: acknowledges up to `lastSeq`, then replays what is still open. Answered by `resumed {lastSeq, replayed}`.   |

Errors arrive as the usual `error {code, message}`: `missing_scope`, `bot_only` (a person sent a gateway
frame), `invalid_token` (the interaction token is wrong or belongs to another bot),
`interaction_not_pending` (already answered, or the deadline passed; use the follow-up endpoint),
`too_many_connections`.

**Interactions.** The server that took the invocation picks the bot's newest live connection (any
instance), publishes `interaction.create` to that connection's Redis topic and waits for the answer. If
the bot has no live connection, or the publish reaches nobody, the invoker gets `interaction.failed`
with `reason: "unreachable"` at once rather than after the deadline. The answer may arrive at a different
instance from the one waiting; it is routed back through Redis, and the first answer wins. A `deferred`
answer is finished through the same REST follow-up endpoint as for an HTTP bot
(`POST /api/interactions/:id/:token/followup`, valid 15 minutes). A frame the bot sends is limited to
16 KiB, so a very large `update_panel` view should be sent with `PUT /api/channels/:id/panels/:key`
instead.

**Events.** The outbox and the delivery table are the log. When the worker fans an event out to a gateway
bot it gives the delivery the bot's next `seq`, handed out under a lock on the bot's row, so numbers
follow commit order. The worker publishes `event` to the bot's newest connection and leaves the delivery
open; it stays open until acknowledged:

- `event.ack {seq}` (or the `lastSeq` of a `resume`) closes every open delivery of that bot with
  `seq` at or below it. Acknowledge in order, after handling.
- Not acknowledged within `GATEWAY_ACK_TIMEOUT_MS` (30 s): the worker sends it again, up to
  `DELIVERY_MAX_ATTEMPTS` sends, then the delivery is `dead` like an HTTP one.
- While the bot has no live connection nothing is sent and no attempt is used; the backlog waits. Open
  deliveries older than `GATEWAY_EVENT_TTL_MS` (24 h), or beyond the newest `GATEWAY_BACKLOG_MAX`
  (10 000) per bot, become `dead` during the worker's retention pass, with `lastError` saying why.
  They appear in `GET /api/bots/:id/deliveries` and can be redelivered.
- `resume {lastSeq}` replays up to 500 open deliveries after `lastSeq` in order; the rest follow
  through the normal send loop.

Delivery is **at least once**: a replay, a retry after a lost ack or two instances racing can send
`seq` 7 twice, and a retry (or the live send that happens when the bot comes online, just before its `resume` replay) can arrive after a higher `seq`. Deduplicate on `seq` (keep the highest one
handled) or on `deliveryId`. `seq` follows delivery creation, not event ids.

**Several sockets.** At most `GATEWAY_MAX_CONNECTIONS` (3) per bot, counted across all instances; a
further one gets `error too_many_connections` and is closed with code 1008 before `hello`. All
interactions and events go to the **newest** connection only (never duplicated across sockets); the
older ones stay connected as warm standbys and take over when the newest closes. A connection that
stops refreshing its presence entry (`GATEWAY_HEARTBEAT_MS`, 10 s; expires after
`GATEWAY_PRESENCE_TTL_MS`, 30 s) is dropped from routing, and the server pings every socket
(`WS_HEARTBEAT_INTERVAL_MS`) and terminates ones that do not answer. Gateway bots get a larger inbound
frame budget than people (`GATEWAY_FRAME_BURST` 200, `GATEWAY_FRAME_REFILL_PER_SECOND` 100); frames
over it get `error rate_limited`, and a socket that keeps flooding is closed.

### Incoming webhooks

| Endpoint                          | Notes                                                                                                                                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/channels/:id/webhooks` | Human with `manage_guild` who can see the channel. `{name, avatarAttachmentId?, format?, template?, secret?}` returns `201 {id, channelId, name, avatarUrl, format, template, hasSecret, createdBy, createdAt, url}`; `url` is `/api/webhooks/:id/:token` and is shown only once. |
| `GET /api/channels/:id/webhooks`  | `{webhooks: Webhook[]}` (no tokens, no secrets; `hasSecret` says whether one is set).                                                                                                                                                                                             |
| `PATCH /api/webhooks/:id`         | Same permission. `{name?, format?, template?, secret?}`; `secret: null` removes it. Returns the `Webhook`.                                                                                                                                                                        |
| `POST /api/webhooks/:id/preview`  | Same permission, human only. `{body, headers?, format?, template?}` returns `{message: {content, embeds, username?} \| null}`. Nothing is posted.                                                                                                                                 |
| `DELETE /api/webhooks/:id`        | `204`. Existing messages stay.                                                                                                                                                                                                                                                    |
| `POST /api/webhooks/:id/:token`   | Posts a message. No other authentication; the path token is the credential. `204`, or `200` with the `Message` when `?wait=true`.                                                                                                                                                 |

The execute endpoint accepts a Discord-compatible payload (the default `discord` format), plus
Slack's `text`. Other formats are described under [Webhook formats and
templates](#webhook-formats-and-templates):

```json
{
  "content": "Deploy finished <@12>",
  "username": "Deployer",
  "avatar_url": "https://example.com/deploy.png",
  "embeds": [
    {
      "title": "Build 42",
      "description": "All green",
      "url": "https://ci.example.com/42",
      "color": 65280,
      "timestamp": "2026-10-22T08:00:00.000Z",
      "fields": [{ "name": "Branch", "value": "main", "inline": true }],
      "footer": { "text": "ci" },
      "author": { "name": "CI" },
      "thumbnail": { "url": "https://example.com/t.png" }
    }
  ]
}
```

- Limits follow Discord: `content`/`text` up to 2000 characters, `username` up to 80, up to 10
  embeds, `title` 256, `description` 4096, 25 fields (`name` 256, `value` 1024), footer text
  2048, author name 256, 6000 characters across all embeds. `url`, `avatar_url` and image URLs
  must be `http(s)`. `embeds[].timestamp` is ISO 8601; Uptime Kuma's `YYYY-MM-DD HH:mm:ss.SSS`
  (UTC) is also accepted. Unknown keys (`tts`, `flags`, `thread_name`, ...) are ignored.
- `content` may be empty when there are embeds. `<@id>` mentions work as in normal messages;
  `@everyone` and `@here` are defused.
- The message is authored by a per-webhook bot user; `username` and `avatar_url` apply to that
  one message as `displayNameOverride` / `avatarUrlOverride`, and `webhookId` is set. Clients
  should show the override in place of the author's name and avatar.
- Limited to 30 requests per minute per webhook: `429 rate_limited` with a `Retry-After`
  header (seconds). A wrong or unknown token is `401 invalid_token`.

#### Webhook formats and templates

`format` is one of `discord` (default), `forgejo`, `github`, `alertmanager`, `grafana`,
`watchtower`, `generic` or `template`. With any format but `discord` the execute endpoint takes the
sender's own body and converts it; with `template` it uses the webhook's `template`.

- Accepted content types on the execute endpoint: `application/json`, `text/plain` (the body is
  passed to the converter as a string, which Watchtower's plain notifications use) and
  `application/x-www-form-urlencoded` with a `payload` field holding JSON (GitHub's older
  delivery type). The body limit is the same as before (1 MB at the proxy). An unparsable JSON
  body is `400 invalid_json`.
- `Discord` bodies are validated exactly as before (`400 invalid_request`). For the other formats
  the converter never rejects a body; it returns a message or nothing. When nothing is left to post
  (an ignored event, an empty rendering) the answer is `204`, also with `?wait=true`.
- Converted output is clamped to the embed limits above, `@everyone` and `@here` are defused, and
  links that are not `http(s)` are dropped.
- The converter reads headers: `X-GitHub-Event`, `X-Forgejo-Event`, `X-Gitea-Event`. Without them
  the Forgejo and GitHub presets guess the event from the body's shape.

**Template** (`format: "template"`; required then, otherwise `null`):

```json
{
  "content": "Backup {{status | upper}}",
  "embed": {
    "title": "{{name}}",
    "description": "{{message | default:\"none\"}}",
    "url": "{{link}}",
    "color": "#2ecc71",
    "fields": [{ "name": "Host", "value": "{{host.name}}", "inline": true }],
    "footer": "{{finished_at}}"
  }
}
```

At least one of `content` and `embed` is required and unknown keys are rejected. Placeholders are
`{{path}}` or `{{path | filter | filter:arg}}` with dot and `[index]` paths; filters are `upper`,
`lower`, `truncate:N`, `default:"text"` and `json`. Saving a template with an unknown filter, a bad
path, an unbalanced `{{`, a path through `__proto__`, `constructor` or `prototype`, more than 100
placeholders or more than 10 fields is `400 invalid_request`. A template is data that is looked
up and pasted; nothing in it is evaluated.

**Secret** (`github` and `forgejo` only; 8 to 200 characters; other formats answer
`400 signature_unsupported`): when set, the execute endpoint requires the HMAC-SHA256 of the raw
body as lower-case hex in `X-Hub-Signature-256: sha256=<hex>` (GitHub and Forgejo) or
`X-Forgejo-Signature` / `X-Gitea-Signature` (bare hex). Otherwise `401 invalid_signature`. The
token is checked first. Moving a webhook to a format that cannot sign removes its secret.

**Preview** takes a sample `body` (any JSON, or a string), optional lower-cased `headers`, and
optionally an unsaved `format` and `template`; each defaults to the saved value. The result is
exactly what the execute endpoint would post, or `{"message": null}`. It needs the signed-in
manager session; the integrations proxy carries no identity, so it is refused there.

`Message` gained four optional fields: `embeds`, `webhookId`, `displayNameOverride`,
`avatarUrlOverride`. `User` gained optional `isBot`. Older clients can ignore all of them.

### Slash commands

**Register** (the bot itself with scope `commands`, or its owner): bulk overwrite of the bot's
commands in one guild. The bot must already be in the guild.

```
PUT /api/bots/:id/guilds/:guildId/commands
[ { "name": "roll", "description": "Roll a die",
    "options": [ { "name": "sides", "description": "Sides", "type": "integer", "required": false } ] } ]
```

`name` matches `^[a-z0-9-]{1,32}$`, `description` is up to 100 characters, up to 10 options per
command, option `type` is `string`, `integer`, `boolean`, `user` or `channel`. A command name is
unique per guild: `409 command_conflict` if another bot owns it. Removing a bot from a guild
removes its commands there.

**List** (for autocomplete): `GET /api/guilds/:id/commands` returns
`{commands: [{botId, botName, name, description, options, moduleId?}]}`. Built-in commands from modules
are listed with `botId: null`, `botName` set to the module's name and `moduleId`. Built-in and bot
commands share one namespace per guild: a built-in name is reserved (registering it is
`409 command_conflict`), a built-in wins at invocation in guilds where its module is enabled, and an
older bot command of the same name is hidden there and works again where the module is off. Built-ins
run in-process, to completion, before the `202`; their outcome is a message from the caller or an
`interaction.ephemeral` frame, and their `interactionId` is a fresh number.

**Invoke** (humans only), in a guild text channel you belong to. Either a WebSocket frame

```json
{
  "type": "command.invoke",
  "channelId": "11",
  "name": "roll",
  "options": { "sides": 20 },
  "nonce": "abc"
}
```

or `POST /api/channels/:id/commands` with `{name, options, nonce?}`, answered `202 {interactionId}`.
Options are validated against the definition before the bot is contacted (`400 invalid_options`,
`404 unknown_command`); `user` options must be guild members and `channel` options channels you
can see in the guild. Invocations are limited per user (`429 rate_limited`). The outcome
arrives asynchronously:

- The bot answered with a message: it is posted as the bot and arrives as a normal
  `message.created` to everyone subscribed.
- Ephemeral answer, `{type:"message", ephemeral:true}`: **not stored**, delivered only to you as
  `interaction.ephemeral`.
- Deferred, `{type:"deferred"}`: you get `interaction.pending` (show "Bot is thinking...") and the
  bot's follow-up arrives later as a message or an ephemeral frame. Clear the indicator when a
  message from that bot appears in the channel, when an `interaction.ephemeral` or
  `interaction.failed` with the same `interactionId` arrives, or at `expiresAt`.
- No answer within 3 seconds, an error, or an invalid response: `interaction.failed` with a
  `reason`: `timeout`, `unreachable`, `bad_status`, `invalid_response`, `blocked_url` or
  `post_failed` (the bot could not post, for example it is not in that channel).

All three frames go to your user topic (every session of yours), carry `interactionId`,
`channelId`, `command`, `botId` and the `nonce` you sent:

```json
{ "type": "interaction.ephemeral", "interactionId": "5", "channelId": "11", "command": "echo", "botId": "9", "content": "only you", "embeds": [], "nonce": "abc" }
{ "type": "interaction.pending", "interactionId": "5", "channelId": "11", "command": "roll", "botId": "9", "expiresAt": "2026-10-22T09:30:00.000Z", "nonce": "abc" }
{ "type": "interaction.failed", "interactionId": "5", "channelId": "11", "command": "roll", "botId": "9", "reason": "timeout", "nonce": "abc" }
```

**What the bot receives**: `POST <interactionsUrl>` with the signed headers below and body

```json
{
  "id": "5",
  "token": "<43 chars>",
  "type": "command",
  "command": { "name": "roll", "options": { "sides": 20 } },
  "guildId": "3",
  "channelId": "11",
  "user": { "id": "8", "login": "alice@example.com", "displayName": "alice" },
  "createdAt": "2026-10-22T09:15:00.000Z",
  "expiresAt": "2026-10-22T09:30:00.000Z"
}
```

The bot answers `2xx` within 3 seconds with one of

```json
{ "type": "message", "content": "text", "embeds": [], "ephemeral": false }
{ "type": "deferred" }
```

and, after a deferred answer, calls (within 15 minutes, any number of times)

```
POST /api/interactions/:id/:token/followup      {content, embeds?, ephemeral?}   ->  201 {messageId|null}
```

The interaction token in the path is the credential (no other auth; `401 invalid_token`,
`410 interaction_expired`). `messageId` is `null` for ephemeral follow-ups.

### Signed requests

Every request the server makes to a bot carries

| Header                  | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| `X-Harmony-Timestamp`   | Unix seconds when it was sent.                                       |
| `X-Harmony-Signature`   | `v1=` + hex `HMAC-SHA256(signingSecret, "<timestamp>.<raw body>")`.  |
| `X-Harmony-Delivery-Id` | Event deliveries only: stable across retries; use it to deduplicate. |

Verify over the **raw** body bytes, compare in constant time and reject timestamps more than 5
minutes from now. `@harmony/shared/signature` exports `sign()` and `verifySignature()` that do
exactly this (see `examples/echo-bot`).

### Outgoing events

Bots with `eventsUrl`, scope `events` and `eventTypes` receive events for guilds they are in:
`message.created`, `message.updated`, `message.deleted`, `reaction.added`, `reaction.removed`,
`guild.member_joined`, `guild.member_left`. Message and reaction events are only sent for
channels the bot is a member of and need `messages.read`. Each is a signed `POST` with body

```json
{
  "id": "1042",
  "type": "message.created",
  "guildId": "3",
  "createdAt": "2026-10-22T09:15:00.000Z",
  "data": { "message": { "...Message": "..." } }
}
```

`data` by type: `message.created` / `message.updated` `{message}` (pins also send
`message.updated`); `message.deleted` `{channelId, messageId}`; `reaction.added` / `.removed`
`{channelId, messageId, emoji, userId}`; `guild.member_joined` `{user}`; `guild.member_left`
`{userId}`. A bot also receives events about its own actions.

Answer with any `2xx` within 5 seconds. Anything else (including redirects, which are not
followed) is retried with exponential backoff and full jitter (base 2 s, cap 1 hour, 8 attempts
in total), after which the delivery is `dead` and can be retried with
`POST /api/bots/:id/deliveries/:deliveryId/redeliver`. Delivery is **at-least-once**: a receiver
can see the same event twice (for example when its response is lost), so deduplicate on
`X-Harmony-Delivery-Id`. Events of one guild are not guaranteed to arrive in order across
retries. Events and delivery records are kept for 7 days.
