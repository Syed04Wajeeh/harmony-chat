# Roles and permissions

What a person may do in a server is decided by roles, with per-channel overrides on top. The
resolution is one pure function (`computePermissions` in `packages/shared/src/permissions.ts`)
that the server uses to enforce and the web client's tests use to check the same table.

- [The model](#the-model)
- [Permission keys](#permission-keys)
- [Resolution order and a worked example](#resolution-order-and-a-worked-example)
- [Hierarchy rules](#hierarchy-rules)
- [Bots](#bots)
- [Who can see a channel: `view_channel` and `channel_members`](#who-can-see-a-channel)
- [Caching and invalidation](#caching-and-invalidation)
- [Module permissions](#module-permissions)
- [Where each key is enforced](#where-each-key-is-enforced)

## The model

- A **server** (guild) has **roles**. Each role has a name, an optional color, a `position`
  (higher outranks lower), `hoist` (shown as its own group in the member list), `mentionable`,
  and a set of permission keys.
- Every server has one **@everyone** role, position 0. Everyone in the server holds it. It cannot
  be renamed, recolored or deleted; only its permissions change. A database trigger creates it with
  every new guild, so no code path can forget to.
- A member holds any number of other roles (`member_roles`). Their permissions are the **union** of
  @everyone and all their roles.
- A **channel overwrite** (`channel_overwrites`) is, for one channel and one target (a role or a
  member), a pair of lists: keys it **allows** and keys it **denies**. A channel can have many.
- The **owner** and **instance admins** (`users.isAdmin`) hold every permission everywhere and
  cannot be restricted. The `administrator` permission does the same for any role that has it
  (but gives no rank: the hierarchy below still goes by role position).
- Direct messages are not in a server: they have no roles and nothing to check.

A new server's @everyone gets: `view_channel`, `send_messages`, `attach_files`, `add_reactions`,
`use_commands`, `create_channels`, `create_invites`, `change_nickname`, `pins.pin`, `polls.create`,
`polls.vote`. Servers that existed before roles got the same set, which is what members could do
before, so nothing changed for them (the migration is `0015_roles`).

## Permission keys

Core keys (`GET /api/guilds/:id/permissions/@me` lists the ones you hold; modules add their own,
see [below](#module-permissions)). **Channel** means an overwrite may allow or deny the key; the
others only make sense server-wide, and an overwrite naming them is rejected with
`400 invalid_permission`.

| Key                | Channel | Allows                                                                                                   |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------- |
| `view_channel`     | yes     | See the channel and read its history. Decides who is in `channel_members`.                               |
| `send_messages`    | yes     | Send messages (REST and WebSocket) and show typing. Without it, typing pings are dropped silently.       |
| `attach_files`     | yes     | Attach uploads to a message. `POST /api/uploads?channelId=` checks it early; sending always checks it.   |
| `add_reactions`    | yes     | Add a reaction (removing your own needs nothing).                                                        |
| `use_commands`     | yes     | Run slash commands.                                                                                      |
| `mention_everyone` | yes     | Reserved: no mass mention exists yet, so nothing enforces it.                                            |
| `manage_messages`  | yes     | Delete other people's messages and pin or unpin.                                                         |
| `create_channels`  | no      | Create channels. Separate from `manage_channels` so members can create channels without editing others'. |
| `manage_channels`  | yes     | Edit and archive any channel, and remove others from a private channel.                                  |
| `manage_roles`     | yes     | Create, edit, reorder and delete roles below your own, assign them, and set channel overwrites.          |
| `manage_guild`     | no      | Rename the server and change its icon; manage modules, bots and webhooks.                                |
| `manage_emoji`     | no      | Upload, rename and delete the server's custom emoji (`custom-emoji` module).                             |
| `create_invites`   | no      | Create invites.                                                                                          |
| `kick_members`     | no      | Remove members who rank below you.                                                                       |
| `manage_nicknames` | no      | Change other members' nicknames (they must rank below you).                                              |
| `change_nickname`  | no      | Change your own nickname.                                                                                |
| `administrator`    | no      | Everything, and channel overwrites do not apply.                                                         |

Deleting a server and transferring it are not keys: they belong to the owner (deleting also to
instance admins), by design.

## Resolution order and a worked example

For a member `M` in channel `C` (or server-wide when no channel is given):

1. If `M` is the owner or an instance admin: everything. Stop.
2. Start with the union of the permissions of @everyone and every role `M` holds. If that contains
   `administrator`: everything. Stop. (Overwrites are never consulted.)
3. If there is a channel, apply its overwrites in this order, later steps winning:
   1. @everyone's overwrite: remove its `deny` keys, then add its `allow` keys.
   2. The overwrites of all of `M`'s roles together: remove every `deny` key, then add every
      `allow` key. Among roles the allow wins over a deny of another role, and position does not
      matter at this step.
   3. `M`'s own member overwrite: remove its `deny` keys, then add its `allow` keys.

The result is the set of keys `M` holds in `C`.

**Example.** The server has @everyone with the defaults above, and a role `Moderator` (position 2)
with `manage_messages`. Channel `#staff` has three overwrites:

- @everyone: deny `view_channel`
- Moderator: allow `view_channel`
- member Bob: deny `send_messages`

| Member                           | Server-wide                  | In `#staff`                                                      |
| -------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| Alice (no roles)                 | the defaults                 | defaults minus `view_channel`: she cannot see the channel at all |
| Carol (Moderator)                | defaults + `manage_messages` | step 3.1 removes `view_channel`, step 3.2 adds it back           |
| Bob (Moderator)                  | defaults + `manage_messages` | like Carol, then 3.3 removes `send_messages`: he reads only      |
| Dave (the owner)                 | everything                   | everything                                                       |
| Erin (role with `administrator`) | everything                   | everything: the @everyone deny does not apply to her             |

If Bob additionally held a role `Speaker` with an overwrite in `#staff` allowing `send_messages`,
step 3.2 would add it and step 3.3 would remove it again: the member overwrite is last.

`apps/server/tests/unit/permissions.test.ts` (16 cases) and the integration suite check this table.

## Hierarchy rules

A member's **rank** is the position of their highest role (0 with none). The owner and instance
admins are **superusers**: they outrank everyone, nothing can be done to them, and they are exempt
from the rules below.

- You can create, edit, delete, reorder and assign or remove a role only if it is **strictly below
  your highest role** (`403 role_hierarchy`). New roles are created at position 1, below everything
  else but above @everyone, and are moved with `PATCH /api/guilds/:id/roles/order`; a move needs
  you to outrank both the old and the new position.
- You can only **hand out permissions you hold yourself** (`403 missing_permission`): when you
  create a role, add keys to a role, or allow keys in a channel overwrite (checked as you hold
  them in that channel).
- `@everyone` can be edited only for its permissions, and only with `manage_roles` and the rule
  above about what you hold.
- You can kick a member, change their nickname, or set a member overwrite for them only if you
  outrank them (`canModerate`: superusers always can; nobody can touch a superuser; otherwise your
  rank must be strictly higher). You may always set your own nickname (with `change_nickname`) and
  your own overwrite.
- The owner cannot leave (`400 owner_cannot_leave`) and cannot be kicked. **Only the owner** can
  transfer the server (`POST /api/guilds/:id/transfer`), and only to a human member; the previous
  owner becomes an ordinary member.
- Instance admins keep the pre-roles override: they resolve as superusers in every server, even
  ones they have not joined.

## Bots

A bot is a user (`kind: "bot"`) and a member of the servers it is installed in, so it holds
@everyone plus any roles it is given, and the same resolution applies to it. A bot's token scopes
(`messages.write` and so on) are a second, independent gate: a request needs both the scope and
the permission. Bots cannot call the role, overwrite, nickname, kick or transfer endpoints: they are
human-only. Removing a bot from a server deletes its member overwrites there.

## Who can see a channel

`view_channel` is the one permission that decides **membership**. The `channel_members` table (who
subscribes to a channel's realtime events, whose unread counts exist, who may read history) is kept
equal to "members who hold `view_channel` in that channel" for every text channel. Everything that
can change the answer ends in `reconcileAccess(guildId, scope)`, in the same transaction as the
change:

- a role's permissions change, a role is deleted, a role is assigned or revoked,
- an overwrite is put or removed,
- a member joins, a channel is created, ownership is transferred.

(Leaving or being kicked removes the member's rows directly.)

The reconcile reads the permission data through the transaction (so it sees its own writes),
compares what each affected member should see to the rows that exist, inserts missing rows
(a newly granted member starts caught up on history: their read marker is the newest message) and
deletes surplus ones. It returns the diff, and after commit the service sends `channel.joined` to
those who gained access and `channel.removed` (ending their live subscription) to those who lost it.

A private channel is just a channel where @everyone is denied `view_channel`. The `isPrivate` flag on
the API is derived from that and kept in sync (`syncPrivacy`). Adding someone to a private channel
(`POST /api/channels/:id/members`) is a member overwrite allowing `view_channel`; removing them is
one denying it. Creating a private channel writes the @everyone deny and an allow for the creator.

**The owner and instance admins see every channel, including private ones.** Before roles a private
channel was invisible to everyone not added to it. Now these two groups hold every permission, so
they appear in `channel_members` of every channel; the migration backfilled those rows. See the
[trust model](security/trust-model.md).

## Caching and invalidation

A permission check must cost no query on the send path. `PermissionService`
(`apps/server/src/permissions/service.ts`) keeps, per process and per server, one `GuildAccess`:
the roles, every member's role ids, admin flag and nickname, and the channel overwrites. It is
loaded with three statements the first time anything asks about the server, then a check is a map
lookup and a few set operations.

- **Invalidation.** Every writer commits, then calls `changed(guildId)`: the cache entry is dropped
  here and the guild id is published on Redis (`harmony:permissions:invalidate`); every other
  instance drops its copy on receipt. The next check reloads. A failed Redis publish does not fail
  the request.
- **Safety net.** An entry older than five minutes is reloaded anyway, so a lost message heals.
- **Bounds.** At most 2,000 servers are cached (oldest dropped first). The channel-to-server lookup
  (`guildOf`) is cached separately, up to 20,000 channels; a channel never changes server.
- **Concurrent loads** share one in-flight promise. A failed load is not cached.
- **Nicknames** of message authors come from the same cache, so listing or sending messages needs
  no join. Inside a database transaction the reader uses the cache without waiting
  (`cachedNicknames`), and callers `warm` the channel first; this is why: a handler that holds a
  pooled connection and waits for a second one can exhaust the pool under load.
- **Cost on the send path.** With a warm cache a send adds no statements: the message insert, the
  re-read, the outbox write and the membership check are the same six as before roles
  (`tests/integration/modules-hotpath.test.ts`). [Performance](performance.md) records a regression
  that came from a join added to the message query and how it was removed.

## Module permissions

A module declares its own keys with `ctx.permissions.define('create', 'Create polls')`; they are
namespaced as `<moduleId>.<key>` (`polls.create`) and appear in the role editor under the module's
name. A key is stored in roles as text, so a role keeps it when the module is switched off and
works again when it returns; overwrites may use module keys too. Modules check permissions with
`ctx.permissions.has / require / requireInChannel` (see [Modules](modules.md#permissions)).

Shipped modules and their keys: `polls.create`, `polls.vote`, `pins.pin`. Reactions use the core
`add_reactions`. All three module keys are in the default @everyone set, so behavior is unchanged
until an admin removes them. For pinning, `manage_messages` OR `pins.pin` is enough: moderators
always can, and `pins.pin` lets a server open pinning to everyone (as it was) or close it.

## Where each key is enforced

| Key                                   | Enforced at                                                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view_channel`                        | `channel_members` (every channel route, history, subscribe, search, attachments, unread counts)                                                                 |
| `send_messages`                       | `MessageService.send` (REST, WebSocket, bot messages), typing frames                                                                                            |
| `attach_files`                        | `MessageService.send` when attachments are given; `POST /api/uploads?channelId=`                                                                                |
| `add_reactions`                       | reactions module, adding only                                                                                                                                   |
| `use_commands`                        | slash command invocation                                                                                                                                        |
| `manage_messages`                     | `DELETE /api/messages/:id` for other people's messages; pins                                                                                                    |
| `create_channels`                     | `POST /api/guilds/:id/channels`                                                                                                                                 |
| `manage_channels`                     | `PATCH /api/channels/:id` and removing others from a private channel (the creator can always do both for their own channel; any channel member can add someone) |
| `manage_roles`                        | role routes, member role changes, overwrite routes                                                                                                              |
| `manage_guild`                        | `PATCH /api/guilds/:id`, module settings, bot install/removal, webhook creation                                                                                 |
| `create_invites`                      | `POST /api/guilds/:id/invites`                                                                                                                                  |
| `kick_members`                        | `DELETE /api/guilds/:id/members/:userId`                                                                                                                        |
| `change_nickname`, `manage_nicknames` | `PATCH /api/guilds/:id/members/:userId`                                                                                                                         |
| `manage_emoji`                        | `POST/PATCH/DELETE /api/guilds/:id/emoji…` (custom emoji module)                                                                                                |
| `mention_everyone`                    | nothing yet (the feature does not exist)                                                                                                                        |

Messages from incoming webhooks skip the membership and permission checks, as before: the webhook
token is the authorization, and creating a webhook needs `manage_guild`.
