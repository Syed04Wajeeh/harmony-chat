import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { ChannelSummary, Message } from '@harmony/shared';
import { createDb } from '../../src/db.js';
import { createMigrator } from '../../src/migrator.js';
import { UserStore } from '../../src/auth/user-store.js';
import {
  TestSocket,
  addMember,
  api,
  createChannel,
  createGuild,
  createInfra,
  ensureDefaultGuild,
  ensureUser,
  insertMessages,
  settle,
  type Infra,
  type TestApp,
} from './support/harness.js';

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

describe('membership and authorization', () => {
  let infra: Infra;
  let target: TestApp;
  const sockets: TestSocket[] = [];

  const connect = async (login: string) => {
    const socket = await TestSocket.connect(target, login);
    sockets.push(socket);
    await socket.waitFor('hello');
    return socket;
  };

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ MESSAGE_RATE_MAX: '1000', RATE_LIMIT_MAX: '10000' });
    await ensureDefaultGuild(infra.db);
  });

  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  it('rejects non-members on every REST endpoint with 403', async () => {
    const member = unique('member');
    const outsider = unique('outsider');
    const channelId = await createChannel(infra.db, [member]);
    const [messageId] = await insertMessages(infra.db, channelId, member, 1);
    const asOutsider = api(target, outsider);
    const authorId = await ensureUser(infra.db, outsider);

    const attempts: [string, string, unknown?][] = [
      ['GET', `/api/channels/${channelId}/messages`],
      ['POST', `/api/channels/${channelId}/messages`, { content: 'hi' }],
      ['GET', `/api/channels/${channelId}/pins`],
      ['GET', `/api/channels/${channelId}/members`],
      ['POST', `/api/channels/${channelId}/read`, { messageId }],
      ['POST', `/api/channels/${channelId}/members`, { userId: authorId }],
      ['PUT', `/api/messages/${messageId}/reactions/%F0%9F%91%8D`],
      ['DELETE', `/api/messages/${messageId}/reactions/%F0%9F%91%8D`],
      ['PUT', `/api/messages/${messageId}/pin`],
      ['DELETE', `/api/messages/${messageId}/pin`],
      ['PATCH', `/api/messages/${messageId}`, { content: 'edit' }],
      ['DELETE', `/api/messages/${messageId}`],
      ['PATCH', `/api/channels/${channelId}`, { topic: 'x' }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await asOutsider(path, { method, body });
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });

  it('rejects non-members on every WebSocket frame with a forbidden error', async () => {
    const member = unique('member');
    const channelId = await createChannel(infra.db, [member]);
    const [messageId] = await insertMessages(infra.db, channelId, member, 1);
    const outsider = await connect(unique('outsider'));

    outsider.send({ type: 'subscribe', channelId });
    outsider.send({ type: 'message.send', channelId, content: 'hi', nonce: 'n1' });
    outsider.send({ type: 'read', channelId, messageId });
    outsider.send({ type: 'typing', channelId });
    const errors = await outsider.waitFor('error', 4);
    expect(errors.map((e) => e.code)).toEqual(Array(4).fill('forbidden'));
    expect(errors[1]?.nonce).toBe('n1');
    expect(outsider.of('backfill')).toHaveLength(0);
  });

  it('returns 404 for channels that do not exist, even to members of others', async () => {
    const res = await api(target, unique('someone'))('/api/channels/999999999/messages');
    expect(res.status).toBe(404);
  });

  it('lands new users in the default guild with its channels', async () => {
    const login = unique('newbie');
    const channels = (await api(target, login)('/api/channels')).body as {
      channels: ChannelSummary[];
    };
    expect(channels.channels.map((c) => c.name)).toContain('general');
    const guilds = (await api(target, login)('/api/guilds')).body as { guilds: { name: string }[] };
    expect(guilds.guilds.map((g) => g.name)).toContain('Harmony');
  });

  describe('first user becomes admin atomically', () => {
    it('promotes exactly one of several simultaneous first logins', async () => {
      const postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
      const db = createDb(postgres.getConnectionUri());
      try {
        await createMigrator(db).migrateToLatest();
        const stores = Array.from({ length: 6 }, () => new UserStore(db));
        const users = await Promise.all(
          stores.map((store, i) =>
            store.resolve({
              login: `racer${i}@example.com`,
              displayName: `racer${i}`,
              avatarUrl: null,
            }),
          ),
        );
        expect(users.filter((u) => u.isAdmin)).toHaveLength(1);
        const counts = await db
          .selectFrom('channel_members')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        expect(Number(counts.n)).toBe(6);
        const guilds = await db.selectFrom('guilds').selectAll().execute();
        expect(guilds).toHaveLength(1);
        expect(guilds[0]).toMatchObject({ name: 'Harmony', is_default: true });
        expect(users.find((u) => u.id === guilds[0]?.owner_id)?.isAdmin).toBe(true);
        const later = await new UserStore(db).resolve({
          login: 'later@example.com',
          displayName: 'later',
          avatarUrl: null,
        });
        expect(later.isAdmin).toBe(false);
      } finally {
        await db.destroy();
        await postgres.stop();
      }
    }, 120_000);
  });

  describe('public and private channels', () => {
    const createIn = (login: string, guildId: string, body: object) =>
      api(target, login)(`/api/guilds/${guildId}/channels`, { method: 'POST', body });

    it('gives every guild member public channels and hides private ones from non-members', async () => {
      const owner = unique('owner');
      const member = unique('member');
      const guildId = await createGuild(infra.db, owner, [member]);
      const pub = (await createIn(owner, guildId, { name: 'open' })).body as ChannelSummary;
      const priv = (await createIn(owner, guildId, { name: 'secret', isPrivate: true }))
        .body as ChannelSummary;

      const list = (await api(target, member)(`/api/guilds/${guildId}/channels`)).body as {
        channels: ChannelSummary[];
      };
      expect(list.channels.map((c) => c.id)).toEqual([pub.id]);
      expect((await api(target, member)(`/api/channels/${priv.id}/messages`)).status).toBe(403);
      expect((await api(target, member)(`/api/channels/${pub.id}/messages`)).status).toBe(200);
    });

    it('no longer offers browse or join for channels', async () => {
      const call = api(target, unique('someone'));
      expect((await call('/api/channels/browse')).status).toBe(404);
      expect((await call('/api/channels/1/join', { method: 'POST' })).status).toBe(404);
    });

    it('pushes new public channels to every member live, and only the creator for private', async () => {
      const owner = unique('owner');
      const member = unique('member');
      const guildId = await createGuild(infra.db, owner, [member]);
      const sidebar = await connect(member);

      const pub = (await createIn(owner, guildId, { name: 'announce' })).body as ChannelSummary;
      expect((await sidebar.waitFor('channel.joined'))[0]?.channel.id).toBe(pub.id);
      await createIn(owner, guildId, { name: 'hidden', isPrivate: true });
      await settle(200);
      expect(sidebar.of('channel.joined')).toHaveLength(1);
    });

    it('lets members invite guild members to a private channel, and only creator, guild owner or admin remove', async () => {
      const guildOwner = unique('gowner');
      const creator = unique('creator');
      const friend = unique('friend');
      const other = unique('other');
      const outsider = unique('outsider');
      const root = unique('root');
      await ensureUser(infra.db, root, { admin: true });
      const guildId = await createGuild(infra.db, guildOwner, [creator, friend, other]);
      const [friendId, otherId, outsiderId] = await Promise.all([
        ensureUser(infra.db, friend),
        ensureUser(infra.db, other),
        ensureUser(infra.db, outsider),
      ]);
      const priv = (await createIn(creator, guildId, { name: 'inner', isPrivate: true }))
        .body as ChannelSummary;
      const base = `/api/channels/${priv.id}/members`;
      const add = (who: string, userId: string) =>
        api(target, who)(base, { method: 'POST', body: { userId } });
      const remove = (who: string, userId: string) =>
        api(target, who)(`${base}/${userId}`, { method: 'DELETE' });

      expect((await add(friend, otherId)).status).toBe(403);
      expect((await add(creator, friendId)).status).toBe(204);
      expect((await add(creator, otherId)).status).toBe(204);
      expect((await add(friend, otherId)).status).toBe(204);
      expect((await add(creator, outsiderId)).status).toBe(404);
      expect((await api(target, friend)(`/api/channels/${priv.id}/messages`)).status).toBe(200);

      expect((await remove(friend, otherId)).status).toBe(403);
      expect((await remove(creator, otherId)).status).toBe(204);
      expect((await api(target, other)(`/api/channels/${priv.id}/messages`)).status).toBe(403);

      await addMember(infra.db, priv.id, guildOwner);
      expect((await remove(guildOwner, friendId)).status).toBe(204);
      await addMember(infra.db, priv.id, friend);
      expect((await remove(root, friendId)).status).toBe(403);
      await addMember(infra.db, priv.id, root);
      expect((await remove(root, friendId)).status).toBe(204);
    });

    it('lets members leave a private channel but not a public one', async () => {
      const owner = unique('owner');
      const member = unique('member');
      const guildId = await createGuild(infra.db, owner, [member]);
      const pub = (await createIn(owner, guildId, { name: 'always' })).body as ChannelSummary;
      const priv = (await createIn(owner, guildId, { name: 'optional', isPrivate: true }))
        .body as ChannelSummary;
      await addMember(infra.db, priv.id, member);
      const call = api(target, member);

      expect((await call(`/api/channels/${pub.id}/leave`, { method: 'POST' })).status).toBe(400);
      expect((await call(`/api/channels/${priv.id}/leave`, { method: 'POST' })).status).toBe(204);
      expect((await call(`/api/channels/${priv.id}/messages`)).status).toBe(403);
    });

    it('ends live delivery when a member is removed', async () => {
      const owner = unique('owner');
      const victim = unique('victim');
      const guildId = await createGuild(infra.db, owner, [victim]);
      const victimId = await ensureUser(infra.db, victim);
      const priv = (await createIn(owner, guildId, { name: 'evict', isPrivate: true }))
        .body as ChannelSummary;
      await api(target, owner)(`/api/channels/${priv.id}/members`, {
        method: 'POST',
        body: { userId: victimId },
      });

      const socket = await connect(victim);
      await socket.subscribe(priv.id);
      await api(target, owner)(`/api/channels/${priv.id}/members/${victimId}`, {
        method: 'DELETE',
      });
      await socket.waitFor('channel.removed');
      await api(target, owner)(`/api/channels/${priv.id}/messages`, {
        method: 'POST',
        body: { content: 'secret' },
      });
      await settle(300);
      expect(socket.of('message.created')).toHaveLength(0);
    });
  });

  describe('direct messages', () => {
    it('creates one DM per pair, from either side, and keeps it private', async () => {
      const a = unique('dm-a');
      const b = unique('dm-b');
      const c = unique('dm-c');
      const [aId, bId] = await Promise.all([ensureUser(infra.db, a), ensureUser(infra.db, b)]);
      await createGuild(infra.db, a, [b, c]);
      const sockB = await connect(b);

      const first = (await api(target, a)('/api/dms', { method: 'POST', body: { userId: bId } }))
        .body as ChannelSummary;
      const again = (await api(target, a)('/api/dms', { method: 'POST', body: { userId: bId } }))
        .body as ChannelSummary;
      const reverse = (await api(target, b)('/api/dms', { method: 'POST', body: { userId: aId } }))
        .body as ChannelSummary;
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () =>
          api(target, c)('/api/dms', { method: 'POST', body: { userId: aId } }),
        ),
      );

      expect(first).toMatchObject({
        kind: 'dm',
        guildId: null,
        name: null,
        isPrivate: true,
        dmUser: { id: bId },
      });
      expect(again.id).toBe(first.id);
      expect(reverse.id).toBe(first.id);
      expect(reverse.dmUser?.id).toBe(aId);
      expect(new Set(concurrent.map((r) => (r.body as ChannelSummary).id)).size).toBe(1);
      expect((await sockB.waitFor('channel.joined'))[0]?.channel.dmUser?.id).toBe(aId);
      expect(new Set(sockB.of('channel.joined').map((f) => f.channel.id))).toEqual(
        new Set([first.id]),
      );

      const members = await infra.db
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', first.id)
        .execute();
      expect(members).toHaveLength(2);

      expect((await api(target, c)(`/api/channels/${first.id}/messages`)).status).toBe(403);
      expect(
        (
          await api(target, a)(`/api/channels/${first.id}/messages`, {
            method: 'POST',
            body: { content: 'psst' },
          })
        ).status,
      ).toBe(201);
    });

    it('refuses to rename, leave, extend or archive a DM, and validates the target', async () => {
      const a = unique('dm-a');
      const b = unique('dm-b');
      const [aId, bId] = await Promise.all([ensureUser(infra.db, a), ensureUser(infra.db, b)]);
      await createGuild(infra.db, a, [b]);
      const dm = (await api(target, a)('/api/dms', { method: 'POST', body: { userId: bId } }))
        .body as ChannelSummary;
      const call = api(target, a);

      expect(
        (await call(`/api/channels/${dm.id}`, { method: 'PATCH', body: { name: 'nope' } })).status,
      ).toBe(400);
      expect((await call(`/api/channels/${dm.id}/leave`, { method: 'POST' })).status).toBe(400);
      expect(
        (await call(`/api/channels/${dm.id}/members`, { method: 'POST', body: { userId: aId } }))
          .status,
      ).toBe(400);
      expect(
        (await call(`/api/channels/${dm.id}/members/${bId}`, { method: 'DELETE' })).status,
      ).toBe(400);
      expect((await call('/api/dms', { method: 'POST', body: { userId: aId } })).status).toBe(400);
      expect(
        (await call('/api/dms', { method: 'POST', body: { userId: '999999999' } })).status,
      ).toBe(404);
      const stranger = await ensureUser(infra.db, unique('stranger'));
      expect((await call('/api/dms', { method: 'POST', body: { userId: stranger } })).status).toBe(
        403,
      );
      const dms = (await call('/api/dms')).body as { channels: ChannelSummary[] };
      expect(dms.channels.map((c) => c.id)).toEqual([dm.id]);
      const list = (await call('/api/channels')).body as { channels: ChannelSummary[] };
      expect(list.channels.find((c) => c.id === dm.id)?.dmUser?.id).toBe(bId);
    });
  });

  describe('creating and changing channels', () => {
    it('validates names, rejects duplicates per guild and allows the same name elsewhere', async () => {
      const owner = unique('owner');
      const call = api(target, owner);
      const guildA = await createGuild(infra.db, owner);
      const guildB = await createGuild(infra.db, owner);
      const create = (guildId: string, body: object) =>
        call(`/api/guilds/${guildId}/channels`, { method: 'POST', body });

      const created = await create(guildA, { name: 'dupe', topic: 'hi' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: 'dupe',
        topic: 'hi',
        kind: 'text',
        guildId: guildA,
      });
      expect((await create(guildA, { name: 'dupe' })).status).toBe(409);
      expect((await create(guildB, { name: 'dupe' })).status).toBe(201);
      for (const bad of ['Upper', 'has space', '', 'x'.repeat(33)]) {
        expect((await create(guildA, { name: bad })).status).toBe(400);
      }
    });

    it('lets only guild members create channels in a guild', async () => {
      const owner = unique('owner');
      const guildId = await createGuild(infra.db, owner);
      const res = await api(target, unique('stranger'))(`/api/guilds/${guildId}/channels`, {
        method: 'POST',
        body: { name: 'nope' },
      });
      expect(res.status).toBe(403);
    });

    it('lets only the creator, guild owner or an admin rename, retopic and archive', async () => {
      const guildOwner = unique('gowner');
      const creator = unique('creator');
      const member = unique('member');
      const root = unique('root');
      await ensureUser(infra.db, root, { admin: true });
      const guildId = await createGuild(infra.db, guildOwner, [creator, member, root]);
      const channelId = await createChannel(infra.db, [], { guildId, createdBy: creator });
      const sidebar = await connect(member);
      const patch = (who: string, body: object) =>
        api(target, who)(`/api/channels/${channelId}`, { method: 'PATCH', body });

      expect((await patch(member, { topic: 'mine now' })).status).toBe(403);
      const renamed = await patch(creator, { name: `r-${Date.now()}`, topic: 'new topic' });
      expect(renamed.status).toBe(200);
      expect((await sidebar.waitFor('channel.updated'))[0]?.channel).toMatchObject({
        id: channelId,
        topic: 'new topic',
      });
      expect((await patch(guildOwner, { topic: 'owner was here' })).status).toBe(200);

      expect((await patch(root, { archived: true })).status).toBe(200);
      await sidebar.waitFor('channel.removed');
      const list = (await api(target, member)('/api/channels')).body as {
        channels: ChannelSummary[];
      };
      expect(list.channels.some((c) => c.id === channelId)).toBe(false);
      const send = await api(target, member)(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        body: { content: 'too late' },
      });
      expect(send.status).toBe(409);

      await patch(root, { archived: false });
      await sidebar.waitFor('channel.joined');
      const back = await api(target, member)(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        body: { content: 'back' },
      });
      expect(back.status).toBe(201);
    });

    it('rejects an empty update', async () => {
      const owner = unique('owner');
      const channelId = await createChannel(infra.db, [owner], { createdBy: owner });
      expect(
        (await api(target, owner)(`/api/channels/${channelId}`, { method: 'PATCH', body: {} }))
          .status,
      ).toBe(400);
    });
  });

  it('delivers a message only to members when mixed users share a socket pool', async () => {
    const member = unique('member');
    const channelId = await createChannel(infra.db, [member]);
    const socket = await connect(member);
    await socket.subscribe(channelId);
    const res = await api(target, member)(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content: 'hello' },
    });
    expect((res.body as Message).channelId).toBe(channelId);
    expect((await socket.waitFor('message.created'))[0]?.message.content).toBe('hello');
  });
});
