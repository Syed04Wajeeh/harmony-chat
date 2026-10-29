import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import type {
  ChannelSummary,
  Guild,
  GuildMember,
  GuildSummary,
  Invite,
  InvitePreview,
  Message,
} from '@harmony/shared';
import { createDb } from '../../src/db.js';
import { createMigrator } from '../../src/migrator.js';
import {
  PROXY_SECRET,
  PUBLIC_ORIGIN,
  TestSocket,
  api,
  createChannel,
  createGuild,
  createInfra,
  ensureUser,
  insertMessages,
  settle,
  type Infra,
  type TestApp,
} from './support/harness.js';

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

describe('guilds', () => {
  let infra: Infra;
  let target: TestApp;
  const sockets: TestSocket[] = [];

  const connect = async (login: string) => {
    const socket = await TestSocket.connect(target, login);
    sockets.push(socket);
    await socket.waitFor('hello');
    return socket;
  };
  const createGuildVia = async (login: string, name = 'Club') =>
    (await api(target, login)('/api/guilds', { method: 'POST', body: { name } }))
      .body as GuildSummary;
  const invite = async (login: string, guildId: string, body: object = {}) =>
    (await api(target, login)(`/api/guilds/${guildId}/invites`, { method: 'POST', body }))
      .body as Invite;
  const accept = (login: string, code: string) =>
    api(target, login)(`/api/invites/${code}/accept`, { method: 'POST' });

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ MESSAGE_RATE_MAX: '1000', RATE_LIMIT_MAX: '10000' });
  });

  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  it('lets a non-admin create a guild, create channels in it and invite others', async () => {
    const owner = unique('plain');
    const friend = unique('friend');
    const ownerId = await ensureUser(infra.db, owner);
    const user = await infra.db
      .selectFrom('users')
      .select('is_admin')
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(user.is_admin).toBe(false);

    const created = await api(target, owner)('/api/guilds', {
      method: 'POST',
      body: { name: '  Book club  ' },
    });
    expect(created.status).toBe(201);
    const guild = created.body as GuildSummary;
    expect(guild).toMatchObject({ name: 'Book club', ownerId, memberCount: 1, unreadCount: 0 });

    const channels = (await api(target, owner)(`/api/guilds/${guild.id}/channels`)).body as {
      channels: ChannelSummary[];
    };
    expect(channels.channels.map((c) => c.name)).toEqual(['general']);
    const extra = await api(target, owner)(`/api/guilds/${guild.id}/channels`, {
      method: 'POST',
      body: { name: 'reading-list' },
    });
    expect(extra.status).toBe(201);

    const code = (await invite(owner, guild.id)).code;
    const accepted = await accept(friend, code);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ id: guild.id, memberCount: 2 });
    const friendChannels = (await api(target, friend)(`/api/guilds/${guild.id}/channels`)).body as {
      channels: ChannelSummary[];
    };
    expect(friendChannels.channels.map((c) => c.name).sort()).toEqual(['general', 'reading-list']);
    expect((await api(target, owner)('/api/guilds/x')).status).toBe(404);
  });

  it('validates guild names', async () => {
    const call = api(target, unique('namer'));
    for (const name of ['', '   ', 'x'.repeat(101)]) {
      expect((await call('/api/guilds', { method: 'POST', body: { name } })).status).toBe(400);
    }
  });

  it('keeps guild channels, history and subscriptions from non-members', async () => {
    const owner = unique('owner');
    const outsider = unique('outsider');
    const guild = await createGuildVia(owner);
    const { channels } = (await api(target, owner)(`/api/guilds/${guild.id}/channels`)).body as {
      channels: ChannelSummary[];
    };
    const channelId = channels[0]?.id ?? '';
    await api(target, owner)(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content: 'members only' },
    });
    const call = api(target, outsider);

    expect((await call(`/api/guilds/${guild.id}/channels`)).status).toBe(403);
    expect((await call(`/api/guilds/${guild.id}/members`)).status).toBe(403);
    expect(
      (await call(`/api/guilds/${guild.id}/invites`, { method: 'POST', body: {} })).status,
    ).toBe(403);
    expect((await call(`/api/channels/${channelId}/messages`)).status).toBe(403);
    expect(
      (await call(`/api/guilds/${guild.id}`, { method: 'PATCH', body: { name: 'mine' } })).status,
    ).toBe(403);
    expect((await call(`/api/guilds/${guild.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await call(`/api/guilds/${guild.id}/leave`, { method: 'POST' })).status).toBe(403);
    const mine = (await call('/api/guilds')).body as { guilds: Guild[] };
    expect(mine.guilds.some((g) => g.id === guild.id)).toBe(false);

    const socket = await connect(outsider);
    socket.send({ type: 'subscribe', channelId });
    expect((await socket.waitFor('error'))[0]?.code).toBe('forbidden');
    const hits = (await call('/api/search?q=members')).body as { messages: Message[] };
    expect(hits.messages).toHaveLength(0);
  });

  describe('invites', () => {
    it('previews, accepts and is idempotent for existing members', async () => {
      const owner = unique('owner');
      const guest = unique('guest');
      const guild = await createGuildVia(owner, 'Preview me');
      const { code } = await invite(owner, guild.id, { maxUses: 1 });
      expect(code).toMatch(/^[A-Za-z0-9_-]{10}$/);

      const preview = (await api(target, guest)(`/api/invites/${code}`)).body as InvitePreview;
      expect(preview).toMatchObject({
        guild: { id: guild.id, name: 'Preview me' },
        memberCount: 1,
        alreadyMember: false,
      });
      const ownerView = (await api(target, owner)(`/api/invites/${code}`)).body as InvitePreview;
      expect(ownerView.alreadyMember).toBe(true);

      const ownerSocket = await connect(owner);
      const guestSocket = await connect(guest);
      expect((await accept(guest, code)).status).toBe(200);
      expect((await guestSocket.waitFor('guild.joined'))[0]?.guild.id).toBe(guild.id);
      expect((await ownerSocket.waitFor('guild.member_joined'))[0]).toMatchObject({
        guildId: guild.id,
        user: { login: guest },
      });

      // Accepting again, even though the single use is spent, changes nothing.
      expect((await accept(guest, code)).status).toBe(200);
      const uses = await infra.db
        .selectFrom('guild_invites')
        .select('uses')
        .where('code', '=', code)
        .executeTakeFirstOrThrow();
      expect(uses.uses).toBe(1);
      expect((await api(target, unique('late'))(`/api/invites/${code}`)).status).toBe(410);
    });

    it('rejects unknown, expired and exhausted invites', async () => {
      const owner = unique('owner');
      const guild = await createGuildVia(owner);
      const expired = await invite(owner, guild.id, { expiresInSeconds: 60 });
      await infra.db
        .updateTable('guild_invites')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('code', '=', expired.code)
        .execute();
      const guest = api(target, unique('guest'));

      expect((await guest('/api/invites/nope')).status).toBe(404);
      expect((await guest('/api/invites/nope/accept', { method: 'POST' })).status).toBe(404);
      expect((await guest(`/api/invites/${expired.code}`)).status).toBe(410);
      const res = await guest(`/api/invites/${expired.code}/accept`, { method: 'POST' });
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ code: 'invite_expired' });
      const members = await infra.db
        .selectFrom('guild_members')
        .select('user_id')
        .where('guild_id', '=', guild.id)
        .execute();
      expect(members).toHaveLength(1);
      expect(
        (
          await api(target, owner)(`/api/guilds/${guild.id}/invites`, {
            method: 'POST',
            body: { maxUses: 0 },
          })
        ).status,
      ).toBe(400);
    });

    it('never exceeds max_uses when many users accept at once', async () => {
      const owner = unique('owner');
      const guild = await createGuildVia(owner);
      const { code } = await invite(owner, guild.id, { maxUses: 3 });
      const guests = Array.from({ length: 10 }, () => unique('racer'));

      const results = await Promise.all(guests.map((guest) => accept(guest, code)));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200)).toHaveLength(3);
      expect(statuses.filter((s) => s === 410)).toHaveLength(7);

      const state = await infra.db
        .selectFrom('guild_invites')
        .select('uses')
        .where('code', '=', code)
        .executeTakeFirstOrThrow();
      expect(state.uses).toBe(3);
      const members = await infra.db
        .selectFrom('guild_members')
        .select('user_id')
        .where('guild_id', '=', guild.id)
        .execute();
      expect(members).toHaveLength(4);
    });

    it('counts a user who accepts twice at once only once', async () => {
      const owner = unique('owner');
      const guest = unique('guest');
      const guild = await createGuildVia(owner);
      const { code } = await invite(owner, guild.id, { maxUses: 5 });
      const results = await Promise.all([
        accept(guest, code),
        accept(guest, code),
        accept(guest, code),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      const state = await infra.db
        .selectFrom('guild_invites')
        .select('uses')
        .where('code', '=', code)
        .executeTakeFirstOrThrow();
      expect(state.uses).toBe(1);
    });
  });

  describe('channels inside guilds', () => {
    it('enforces name uniqueness per guild at the database level too', async () => {
      const a = await createGuild(infra.db, unique('a'));
      const b = await createGuild(infra.db, unique('b'));
      await createChannel(infra.db, [], { guildId: a, name: 'same', createdBy: unique('x') });
      await createChannel(infra.db, [], { guildId: b, name: 'same', createdBy: unique('y') });
      await expect(
        createChannel(infra.db, [], { guildId: a, name: 'same', createdBy: unique('z') }),
      ).rejects.toThrow(/channels_guild_id_name_key/);
    });

    it('requires a guild for text channels and none for DMs', async () => {
      await expect(
        sql`insert into channels (name) values ('orphan')`.execute(infra.db),
      ).rejects.toThrow(/channels_shape_check/);
    });

    it('adds a joining member to existing public channels but not private ones', async () => {
      const owner = unique('owner');
      const guest = unique('guest');
      const guild = await createGuildVia(owner);
      const call = api(target, owner);
      const pub = (
        await call(`/api/guilds/${guild.id}/channels`, { method: 'POST', body: { name: 'lobby' } })
      ).body as ChannelSummary;
      const priv = (
        await call(`/api/guilds/${guild.id}/channels`, {
          method: 'POST',
          body: { name: 'vault', isPrivate: true },
        })
      ).body as ChannelSummary;
      await accept(guest, (await invite(owner, guild.id)).code);

      expect((await api(target, guest)(`/api/channels/${pub.id}/messages`)).status).toBe(200);
      expect((await api(target, guest)(`/api/channels/${priv.id}/messages`)).status).toBe(403);
    });
  });

  describe('leaving and deleting', () => {
    it('removes access, live subscriptions and sidebar entries when a member leaves', async () => {
      const owner = unique('owner');
      const leaver = unique('leaver');
      const guild = await createGuildVia(owner);
      await accept(leaver, (await invite(owner, guild.id)).code);
      const { channels } = (await api(target, leaver)(`/api/guilds/${guild.id}/channels`)).body as {
        channels: ChannelSummary[];
      };
      const channelId = channels[0]?.id ?? '';
      const ownerSocket = await connect(owner);
      const socket = await connect(leaver);
      await socket.subscribe(channelId);

      expect(
        (await api(target, leaver)(`/api/guilds/${guild.id}/leave`, { method: 'POST' })).status,
      ).toBe(204);
      expect((await socket.waitFor('guild.removed'))[0]?.guildId).toBe(guild.id);
      expect((await socket.waitFor('channel.removed'))[0]?.channelId).toBe(channelId);
      expect((await ownerSocket.waitFor('guild.member_left'))[0]).toMatchObject({
        guildId: guild.id,
      });

      expect((await api(target, leaver)(`/api/channels/${channelId}/messages`)).status).toBe(403);
      expect((await api(target, leaver)(`/api/guilds/${guild.id}/channels`)).status).toBe(403);
      await api(target, owner)(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        body: { content: 'gone' },
      });
      await settle(300);
      expect(socket.of('message.created')).toHaveLength(0);
      const left = await infra.db
        .selectFrom('channel_members')
        .select('channel_id')
        .where('channel_id', '=', channelId)
        .execute();
      expect(left).toHaveLength(1);
    });

    it('stops the owner from leaving and lets only the owner or an admin delete', async () => {
      const owner = unique('owner');
      const member = unique('member');
      const root = unique('root');
      await ensureUser(infra.db, root, { admin: true });
      const guild = await createGuildVia(owner);
      await accept(member, (await invite(owner, guild.id)).code);
      const { channels } = (await api(target, owner)(`/api/guilds/${guild.id}/channels`)).body as {
        channels: ChannelSummary[];
      };
      const channelId = channels[0]?.id ?? '';
      const memberSocket = await connect(member);

      const leave = await api(target, owner)(`/api/guilds/${guild.id}/leave`, { method: 'POST' });
      expect(leave.status).toBe(400);
      expect(leave.body).toMatchObject({ code: 'owner_cannot_leave' });
      expect(
        (await api(target, member)(`/api/guilds/${guild.id}`, { method: 'DELETE' })).status,
      ).toBe(403);
      expect(
        (
          await api(target, member)(`/api/guilds/${guild.id}`, {
            method: 'PATCH',
            body: { name: 'mine' },
          })
        ).status,
      ).toBe(403);

      expect(
        (await api(target, root)(`/api/guilds/${guild.id}`, { method: 'DELETE' })).status,
      ).toBe(204);
      expect((await memberSocket.waitFor('guild.removed'))[0]?.guildId).toBe(guild.id);
      expect((await memberSocket.waitFor('channel.removed'))[0]?.channelId).toBe(channelId);
      expect((await api(target, owner)(`/api/channels/${channelId}/messages`)).status).toBe(404);
    });

    it('renames a guild and tells every member', async () => {
      const owner = unique('owner');
      const member = unique('member');
      const guild = await createGuildVia(owner);
      await accept(member, (await invite(owner, guild.id)).code);
      const socket = await connect(member);

      const renamed = await api(target, owner)(`/api/guilds/${guild.id}`, {
        method: 'PATCH',
        body: { name: 'Renamed' },
      });
      expect(renamed.body).toMatchObject({ id: guild.id, name: 'Renamed', memberCount: 2 });
      expect((await socket.waitFor('guild.updated'))[0]?.guild.name).toBe('Renamed');
      expect(
        (await api(target, owner)(`/api/guilds/${guild.id}`, { method: 'PATCH', body: {} })).status,
      ).toBe(400);
    });
  });

  it('lists members with their presence', async () => {
    const owner = unique('owner');
    const member = unique('member');
    const guild = await createGuildVia(owner);
    await accept(member, (await invite(owner, guild.id)).code);
    await connect(member);

    const { members } = (await api(target, owner)(`/api/guilds/${guild.id}/members`)).body as {
      members: GuildMember[];
    };
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.login === member)?.status).toBe('online');
    expect(members.find((m) => m.login === owner)?.status).toBe('offline');
  });

  it('sums unread and mention counts per guild and scopes the user list to shared guilds', async () => {
    const me = unique('me');
    const other = unique('other');
    const stranger = unique('stranger');
    const guildId = await createGuild(infra.db, other, [me]);
    await ensureUser(infra.db, stranger);
    const first = await createChannel(infra.db, [], { guildId, createdBy: other });
    const second = await createChannel(infra.db, [], { guildId, createdBy: other });
    await insertMessages(infra.db, first, other, 3);
    await insertMessages(infra.db, second, other, 2);
    const meId = await ensureUser(infra.db, me);
    await api(target, other)(`/api/channels/${second}/messages`, {
      method: 'POST',
      body: { content: `<@${meId}> hi` },
    });

    const { guilds } = (await api(target, me)('/api/guilds')).body as { guilds: GuildSummary[] };
    expect(guilds.find((g) => g.id === guildId)).toMatchObject({ unreadCount: 6, mentionCount: 1 });

    const visible = (await api(target, me)('/api/users')).body as { users: { login: string }[] };
    const logins = visible.users.map((u) => u.login);
    expect(logins).toContain(other);
    expect(logins).not.toContain(stranger);
  });

  it('shows a guild icon to signed-in users and keeps the upload from being cleaned', async () => {
    const owner = unique('owner');
    const guild = await createGuildVia(owner);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'icon.png');
    const upload = await fetch(`${target.url}/api/uploads`, {
      method: 'POST',
      headers: {
        'x-harmony-proxy-secret': PROXY_SECRET,
        'tailscale-user-login': owner,
        origin: PUBLIC_ORIGIN,
      },
      body: form,
    });
    const attachment = (await upload.json()) as { id: string };

    const notImage = await api(target, owner)(`/api/guilds/${guild.id}`, {
      method: 'PATCH',
      body: { iconAttachmentId: crypto.randomUUID() },
    });
    expect(notImage.status).toBe(400);
    const set = await api(target, owner)(`/api/guilds/${guild.id}`, {
      method: 'PATCH',
      body: { iconAttachmentId: attachment.id },
    });
    const iconUrl = (set.body as Guild).iconUrl ?? '';
    expect(iconUrl).toContain(attachment.id);

    const view = await fetch(`${target.url}${iconUrl}`, {
      headers: { 'x-harmony-proxy-secret': PROXY_SECRET, 'tailscale-user-login': unique('viewer') },
    });
    expect(view.status).toBe(200);
    expect(view.headers.get('content-type')).toBe('image/png');
  });
});

describe('default guild migration', () => {
  it('moves existing channels and users into a default guild owned by the first user', async () => {
    const postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    const db = createDb(postgres.getConnectionUri());
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateTo('0002_channels_messages')).error).toBeUndefined();
      await sql`insert into users (login, display_name) values ('first@example.com', 'First'), ('second@example.com', 'Second')`.execute(
        db,
      );
      await sql`
        insert into messages (channel_id, author_id, content)
        select c.id, u.id, 'old message ' || n
        from channels c cross join users u cross join generate_series(1, 3) n
        where c.name = 'general' and u.login = 'second@example.com'
      `.execute(db);

      const { error } = await migrator.migrateToLatest();
      expect(error).toBeUndefined();

      const guild = await db.selectFrom('guilds').selectAll().executeTakeFirstOrThrow();
      const first = await db
        .selectFrom('users')
        .selectAll()
        .where('login', '=', 'first@example.com')
        .executeTakeFirstOrThrow();
      // 0018 later clears the flag: no guild is a lobby until an admin picks one.
      expect(guild).toMatchObject({ name: 'Harmony', is_default: false, owner_id: first.id });
      expect(first.is_admin).toBe(true);

      const members = await db
        .selectFrom('guild_members')
        .select('user_id')
        .where('guild_id', '=', guild.id)
        .execute();
      expect(members).toHaveLength(2);
      const general = await db
        .selectFrom('channels')
        .selectAll()
        .where('name', '=', 'general')
        .executeTakeFirstOrThrow();
      expect(general.guild_id).toBe(guild.id);
      const messages = await db
        .selectFrom('messages')
        .select('id')
        .where('channel_id', '=', general.id)
        .execute();
      expect(messages).toHaveLength(3);
      const access = await db
        .selectFrom('channel_members')
        .select(['user_id', 'last_read_message_id'])
        .where('channel_id', '=', general.id)
        .execute();
      expect(access).toHaveLength(2);
      expect(access.every((row) => row.last_read_message_id !== null)).toBe(true);

      await sql`insert into guilds (name, owner_id, is_default) values ('Lobby', ${first.id}, true)`.execute(
        db,
      );
      await expect(
        sql`insert into guilds (name, owner_id, is_default) values ('Another', ${first.id}, true)`.execute(
          db,
        ),
      ).rejects.toThrow(/guilds_single_default_idx/);
    } finally {
      await db.destroy();
      await postgres.stop();
    }
  }, 120_000);
});
