# Harmony API and WebSocket protocol

This is the contract between the server and the web client. The authoritative schemas are the
zod definitions in `packages/shared/src` (`chat.ts`, `protocol.ts`); this document explains
behavior and gives examples.

## Conventions

- Base path `/api`. Bodies are JSON (`Content-Type: application/json`) except uploads.
- **Ids are strings** of decimal digits (`"42"`), never numbers. Attachment ids are UUIDs. Guild
  invite codes are 10 URL-safe characters.
- Timestamps are ISO 8601 UTC strings (`"2026-10-22T09:15:00.000Z"`).
- Identity comes from the Tailscale headers added by the proxy; there is no login. Every
  non-GET request and the WebSocket upgrade must carry an `Origin` equal to the public origin
  (browsers do this automatically), otherwise `403 bad_origin`.
- Errors are `{ "code": "...", "message": "..." }` with the HTTP status shown below. Common to
  all endpoints:

| Status  | code              | Meaning                                                                                                                                             |
| ------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400     | `invalid_request` | Body, query or params failed validation                                                                                                             |
| 401/403 | auth codes        | `no_identity`, `proxy_required`, `not_allowed`, `bad_origin`                                                                                        |
| 403     | `forbidden`       | Authenticated but not allowed (usually: not a member)                                                                                               |
| 404     | `*_not_found`     | Resource does not exist (`channel_not_found`, `message_not_found`, `guild_not_found`, `user_not_found`, `attachment_not_found`, `invite_not_found`) |
| 429     | `rate_limited`    | Too many requests, sends, reactions or uploads                                                                                                      |

- A channel, message or guild you cannot access answers **403 `forbidden`**, not 404, when it
  exists. Unknown ids answer 404.
- Everything is newest-id-wins ordered by numeric id. Compare ids as BigInt or by (length, string).

## Concepts

- **Guild** (the UI calls it a "server"): a group of users with channels. Any signed-in user can
  create one and becomes its owner. `users.isAdmin` is an instance-level moderation override
  only; it is never required to create guilds or channels.
- **Channel**: `kind: "text"` belongs to exactly one guild (`guildId`); `kind: "dm"` has
  `guildId: null`, `name: null`, exactly two members and lives outside any guild.
- **Visibility**: a public text channel is visible to every guild member (they all get a
  membership row automatically, including when they join the guild later). A private channel
  (`isPrivate: true`) is visible only to the members added to it. DMs are private to their two
  users.
- **Unread counts** (`unreadCount`, `mentionCount`) never exceed 100; `100` means "100 or more".
  They count messages after `lastReadMessageId` that are not yours and not deleted.
- **Default guild**: new users are added to the default guild ("Harmony") on their first request.

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

// ChannelSummary = Channel + your read state. For a DM, name is null and dmUser is the other person.
{ "id": "11", "guildId": "3", "kind": "text", "name": "general", "topic": "Hello",
  "isPrivate": false, "createdBy": "7", "dmUser": null,
  "unreadCount": 3, "mentionCount": 0, "lastMessageId": "980", "lastReadMessageId": "977" }

// Message
{
  "id": "981", "channelId": "11",
  "author": { "id": "7", "login": "ada@example.com", "displayName": "Ada", "avatarUrl": null },
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
  "mentions": ["8"]
}
```

Message notes:

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

Response `200` `{ "users": DirectoryUser[] }`: you plus everyone who shares at least one guild
with you, ordered by display name. Use for mention autocomplete and starting DMs.

### `GET /api/presence`

Response `200` `{ "presence": [ { "userId": "8", "status": "online" | "idle" | "dnd" } ] }`.
Users that are not listed are offline (this includes invisible users). Fetch once after each
(re)connect, then apply `presence.updated` frames.

## Guilds

### `GET /api/guilds`

Response `200` `{ "guilds": GuildSummary[] }`, ordered by name.

### `POST /api/guilds`

Body `{ "name": "Book club" }` (trimmed, 1-100 chars). Response `201` GuildSummary. The caller
becomes owner and member, and a `general` channel is created. Errors: `400`.

### `PATCH /api/guilds/:id`

Owner (or instance admin) only. Body: any of `{ "name": string, "iconAttachmentId": uuid | null }`
(at least one). The icon must be an image (png, jpeg, gif or webp) uploaded by you with
`POST /api/uploads` and not yet attached to a message; `null` removes it. Response `200` Guild.
Errors: `400 invalid_icon`, `403`, `404 guild_not_found`.

### `DELETE /api/guilds/:id`

Owner (or instance admin) only. Deletes the guild, its channels and messages. Response `204`.
Members receive `channel.removed` for every channel and then `guild.removed`.

### `POST /api/guilds/:id/leave`

Response `204`. You lose access to all channels of the guild, including private ones.
Errors: `400 owner_cannot_leave` (the owner must delete the guild), `403` if not a member.

### `GET /api/guilds/:id/channels`

Members only. Response `200` `{ "channels": ChannelSummary[] }`: public channels plus private
channels you belong to, archived channels excluded.

### `POST /api/guilds/:id/channels`

Any member. Body `{ "name": "dev-chat", "topic"?: string (<=256), "isPrivate"?: boolean }`;
`name` matches `^[a-z0-9-]{1,32}$` and is unique within the guild. Response `201` ChannelSummary.
A public channel appears for every guild member (`channel.joined`); a private one only for you.
Errors: `400`, `403`, `409 name_taken`.

### `GET /api/guilds/:id/members`

Members only. Response `200`
`{ "members": [ DirectoryUser & { "status": "online"|"idle"|"dnd"|"offline", "joinedAt": "..." } ] }`.

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

### `GET /api/invites/:code`

Any signed-in user. Response `200`:

```json
{
  "code": "k3Jq9_xT2a",
  "guild": { "id": "3", "name": "Book club", "iconUrl": null },
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

## Channels

### `GET /api/channels`

All your channels across guilds plus your DMs, with read state. Response `200`
`{ "channels": ChannelSummary[] }` (archived excluded; text channels ordered by name, DMs last).

### `GET /api/dms`

Same shape, DMs only.

### `POST /api/dms`

Body `{ "userId": "8" }`. Response `200` ChannelSummary (`kind: "dm"`, `dmUser` set). Idempotent:
the same pair always yields the same channel, whoever starts it. The other user receives
`channel.joined` the first time. Errors: `400` (yourself), `403` (you share no guild with them),
`404 user_not_found`.

### `PATCH /api/channels/:id`

Body: any of `{ "name": string, "topic": string | null, "archived": boolean }` (at least one).
Allowed for the channel's creator, the guild owner and instance admins who are members of the
channel. Response `200` Channel. Members get `channel.updated`; archiving sends
`channel.removed` (and unarchiving `channel.joined`) to every member. Errors: `400 dm_immutable`,
`403`, `409 name_taken`.

### `GET /api/channels/:id/members`

Members only. Response `200` `{ "members": DirectoryUser[] }`.

### `POST /api/channels/:id/members`

Private text channels only. Any member can add a guild member. Body `{ "userId": "8" }`.
Response `204`; the added user receives `channel.joined`. Errors: `400 public_channel`,
`400 dm_immutable`, `404 user_not_found` (not in this guild), `409 channel_archived`.

### `DELETE /api/channels/:id/members/:userId`

Private text channels only. Removing yourself is leaving. Removing others requires being the
channel creator, guild owner or instance admin (and a member). Response `204`; the removed user
receives `channel.removed` and their live subscription ends. Errors: `400 public_channel`,
`400 dm_immutable`, `403`.

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

Members only. Body:

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
`403`, `409 channel_archived`, `429`.

### `PATCH /api/messages/:id`

Author only. Body `{ "content": "new text" }` (1-4000 chars). Sets `editedAt`. Response `200`
Message; broadcast as `message.updated`. Newly mentioned users get a `mention`. Errors:
`403`, `404` (also for deleted messages).

### `DELETE /api/messages/:id`

Author or instance admin. Soft delete. Response `204` (also if already deleted); broadcast as
`message.deleted`.

### `PUT /api/messages/:id/reactions/:emoji` and `DELETE` (same path)

Members only. `:emoji` is URL-encoded: a single Unicode emoji (`%F0%9F%91%8D`) or a custom
shortcode `:name:` (`^:[a-z0-9_]{2,32}:$`, encoded as `%3Aname%3A`). Response `204`; both are
idempotent. Broadcast as `reaction.added` / `reaction.removed` only when something changed.
A message holds at most 20 distinct emoji. Errors: `400 invalid_emoji`, `400 reaction_limit`,
`404`, `429`.

### `PUT /api/messages/:id/pin` and `DELETE /api/messages/:id/pin`

Any member. Response `200` Message (with `pinnedAt`/`pinnedBy` set or cleared). Broadcast as
`message.updated` when it changed.

### `GET /api/channels/:id/pins`

Members only. Response `200` `{ "messages": Message[] }`, newest pin first, at most 50.

## Search

### `GET /api/search?q=<text>&channelId=<id>&before=<id>&limit=<1..100, default 50>`

Full-text search over messages in channels you belong to, newest first, excluding deleted
messages. `q` (1-200 chars) uses web-search syntax: words are ANDed, `"quoted phrases"`, `or`,
and `-exclude` work. Matching is on whole words with no stemming. `channelId` narrows to one
channel (not a member: empty result). Page by passing the last returned id as `before`.
Response `200` `{ "messages": Message[], "hasMore": boolean }` (newest first, unlike history).

## Uploads

### `POST /api/uploads`

`multipart/form-data` with exactly one file field (any field name). Limits: 10 MiB by default
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
per-user events (`channel.*`, `guild.*`, `read.updated`, `mention`) and for `presence.updated`
about everyone. Channel events (messages, reactions, typing) arrive only for channels you have
subscribed to. After a reconnect: re-fetch `GET /api/presence`, `GET /api/guilds` and
`GET /api/channels`, and re-`subscribe` with `lastSeenId`.

**Flood protection**: each socket has a token bucket of 30 frames, refilled at 3 per second.
Frames beyond it are dropped with `{"type":"error","code":"rate_limited"}`; after 100 dropped
frames the server closes the socket with code 1008. Typing pings are further throttled
(below).

### Client to server

| `type`         | Fields                                                          | Effect                                                                                                                         |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `subscribe`    | `channelId`, `lastSeenId?`                                      | Start receiving the channel's events. Members only. Answered with `backfill`.                                                  |
| `unsubscribe`  | `channelId`                                                     | Stop receiving. No reply.                                                                                                      |
| `message.send` | `channelId`, `content`, `nonce`, `replyToId?`, `attachmentIds?` | Same rules as `POST /messages`. Answered with `ack` (to you) and `message.created` (to subscribers). `nonce` is required here. |
| `read`         | `channelId`, `messageId`                                        | Same as `POST /channels/:id/read`. Answered with `read.updated` to all your sessions.                                          |
| `typing`       | `channelId`                                                     | Relays `typing` to subscribers. Members only; ignored if you sent one for this channel in the last 2 seconds.                  |
| `presence.set` | `status` (`online`, `idle`, `dnd`, `invisible`)                 | Same as `PATCH /api/me`. No reply.                                                                                             |

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
`read` and `typing`.

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
{ "type": "guild.removed", "guildId": "3" }
{ "type": "guild.member_joined", "guildId": "3", "user": { "...DirectoryUser": "..." } }
{ "type": "guild.member_left", "guildId": "3", "userId": "8" }
```

- `channel.joined` is sent when a channel appears for you: you were added to a private channel,
  a public channel was created in one of your guilds, a DM was opened with you, a channel was
  unarchived. `channel.removed` is the reverse (removed, left, archived, guild left or deleted).
  Add or drop the sidebar entry and its subscription.
- On `guild.joined` fetch `GET /api/guilds/:id/channels` for the guild's channels.
- `mention` means someone mentioned you in a message or edit (never your own). Combine with
  `read.updated` counts for badges.

**Presence** (broadcast to every connected client)

```json
{ "type": "presence.updated", "userId": "8", "status": "online" }
```

`status` is `online`, `idle`, `dnd` or `offline`. An `invisible` user is reported as `offline`.
It is sent when a user's first connection opens, their last one closes or times out (up to
about 2 minutes after a crash), or they change their status. Presence is not scoped per guild
at this size; filter by the users you display.
