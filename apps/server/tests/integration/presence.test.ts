import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PresenceEvent,
  presenceGuildTopic,
  type GuildSummary,
  type Invite,
  type Me,
  type PresenceEntry,
  type PresenceResponse,
} from '@harmony/shared';
import { PresenceService } from '../../src/presence/service.js';
import { EventBus } from '../../src/realtime/events.js';
import {
  TestSocket,
  api,
  createInfra,
  ensureUser,
  settle,
  type Infra,
  type TestApp,
} from './support/harness.js';

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const BATCH_MS = 150;
const FAST = {
  PRESENCE_TTL_MS: '1500',
  PRESENCE_HEARTBEAT_MS: '300',
  PRESENCE_SWEEP_MS: '300',
  PRESENCE_BATCH_MS: String(BATCH_MS),
  MESSAGE_RATE_MAX: '1000',
  RATE_LIMIT_MAX: '10000',
};
const noLog = { warn: () => undefined };

/** Every presence update a socket received, in order, flattened out of its batch frames. */
const updatesOf = (socket: TestSocket): PresenceEntry[] =>
  socket.of('presence.batch').flatMap((frame) => frame.updates);

describe('presence', () => {
  let infra: Infra;
  let a: TestApp;
  let b: TestApp;
  let listener: Redis;
  /** Raw bus events per topic, as published (before any batching). */
  const events = new Map<string, PresenceEvent[]>();
  const sockets: TestSocket[] = [];

  const connect = async (app: TestApp, login: string) => {
    const socket = await TestSocket.connect(app, login);
    sockets.push(socket);
    await socket.waitFor('hello');
    return socket;
  };
  const until = async (check: () => boolean, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const createGuildVia = async (login: string) =>
    (await api(a, login)('/api/guilds', { method: 'POST', body: { name: 'Club' } }))
      .body as GuildSummary;
  const join = async (owner: string, guildId: string, login: string) => {
    const code = (
      (await api(a, owner)(`/api/guilds/${guildId}/invites`, { method: 'POST', body: {} }))
        .body as Invite
    ).code;
    expect((await api(a, login)(`/api/invites/${code}/accept`, { method: 'POST' })).status).toBe(
      200,
    );
  };
  /** A guild with the given members (the first owns it). */
  const guildOf = async (logins: string[]) => {
    const [owner, ...rest] = logins as [string, ...string[]];
    const guild = await createGuildVia(owner);
    for (const login of rest) await join(owner, guild.id, login);
    return guild.id;
  };
  const presenceOf = async (app: TestApp, login: string) =>
    ((await api(app, login)('/api/presence')).body as PresenceResponse).presence;
  const statusIn = (entries: PresenceEntry[], userId: string) =>
    entries.find((e) => e.userId === userId)?.status;
  const mine = (socket: TestSocket, userId: string) =>
    updatesOf(socket)
      .filter((u) => u.userId === userId)
      .map((u) => u.status);
  const busEvents = (guildId: string, userId: string) =>
    (events.get(presenceGuildTopic(guildId)) ?? []).filter((e) => e.userId === userId);
  const listen = (guildId: string) => listener.subscribe(presenceGuildTopic(guildId));

  beforeAll(async () => {
    infra = createInfra();
    [a, b] = await Promise.all([infra.startApp(FAST), infra.startApp(FAST)]);
    listener = infra.redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
    listener.on('message', (topic, payload: string) => {
      const list = events.get(topic) ?? [];
      list.push(PresenceEvent.parse(JSON.parse(payload)));
      events.set(topic, list);
    });
  });

  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    listener.disconnect();
    await infra.stop();
  });

  describe('transition script', () => {
    // A long TTL so nothing expires while the transitions are exercised.
    const service = (ttlMs = 60_000) =>
      new PresenceService(
        infra.redis,
        infra.db,
        new EventBus(infra.redis),
        { ttlMs, sweepMs: 60_000 },
        noLog,
      );
    const userInGuild = async (name: string) => {
      const login = unique(name);
      const userId = await ensureUser(infra.db, login);
      const guildId = (await createGuildVia(login)).id;
      await listen(guildId);
      return { userId, guildId };
    };

    it('reports online once for many connections and offline once for the last', async () => {
      const { userId, guildId } = await userInGuild('lua');
      const presence = service();

      await Promise.all([presence.touch(userId, 'c1'), presence.touch(userId, 'c2')]);
      await presence.touch(userId, 'c1');
      await settle();
      expect(busEvents(guildId, userId).map((e) => e.status)).toEqual(['online']);

      await presence.disconnect(userId, 'c1');
      await settle();
      expect(busEvents(guildId, userId)).toHaveLength(1);

      await presence.disconnect(userId, 'c2');
      await presence.disconnect(userId, 'c2');
      await presence.sweep();
      await settle();
      expect(busEvents(guildId, userId).map((e) => e.status)).toEqual(['online', 'offline']);
    });

    it('decides each transition once when many callers race', async () => {
      const { userId, guildId } = await userInGuild('race');
      const presences = Array.from({ length: 5 }, () => service());

      await Promise.all(presences.map((p, i) => p.touch(userId, `conn-${i}`)));
      await settle();
      expect(busEvents(guildId, userId).map((e) => e.status)).toEqual(['online']);

      await Promise.all(presences.map((p, i) => p.disconnect(userId, `conn-${i}`)));
      await settle();
      expect(busEvents(guildId, userId).map((e) => e.status)).toEqual(['online', 'offline']);
    });

    it('expires stale connections on sweep and only then reports offline', async () => {
      const { userId, guildId } = await userInGuild('stale');
      const short = service(200);
      await short.touch(userId, 'ghost');
      await short.sweep();
      await settle(50);
      expect(busEvents(guildId, userId).map((e) => e.status)).toEqual(['online']);

      await settle(300);
      await Promise.all([short.sweep(), short.sweep(), short.sweep()]);
      await settle();
      expect(busEvents(guildId, userId).map((e) => e.status)).toEqual(['online', 'offline']);
    });

    it('publishes to every guild and DM of the user, and to nothing else', async () => {
      const login = unique('multi');
      const other = unique('other');
      const userId = await ensureUser(infra.db, login);
      const first = (await createGuildVia(login)).id;
      const second = (await createGuildVia(login)).id;
      const unrelated = (await createGuildVia(other)).id;
      await Promise.all([first, second, unrelated].map(listen));

      await service().touch(userId, 'c1');
      await settle();
      expect(busEvents(first, userId)).toHaveLength(1);
      expect(busEvents(second, userId)).toHaveLength(1);
      expect(busEvents(unrelated, userId)).toHaveLength(0);
    });

    it('keeps the shown status in one place: set on connect, changed live, cleared on offline', async () => {
      const login = unique('shown');
      const userId = await ensureUser(infra.db, login);
      await createGuildVia(login);
      const presence = service();
      expect(await presence.statusesOf([userId])).toEqual([]);

      await presence.touch(userId, 'c1', { status: 'dnd' });
      expect(await presence.statusesOf([userId])).toEqual([{ userId, status: 'dnd' }]);
      await presence.statusChanged(userId, 'idle');
      expect(await presence.statusesOf([userId])).toEqual([{ userId, status: 'idle' }]);
      await presence.statusChanged(userId, 'invisible');
      expect(await presence.statusesOf([userId])).toEqual([]);
      await presence.disconnect(userId, 'c1');
      // Changing the status of an offline user does not make them appear.
      await presence.statusChanged(userId, 'online');
      expect(await presence.statusesOf([userId])).toEqual([]);
    });
  });

  describe('scoping', () => {
    it('never delivers presence to a user who shares no guild or DM', async () => {
      const alice = unique('alice');
      const mate = unique('mate');
      const stranger = unique('stranger');
      const aliceId = await ensureUser(infra.db, alice);
      await guildOf([alice, mate]);
      await createGuildVia(stranger);

      // Sockets on both instances, connected before Alice.
      const strangerA = await connect(a, stranger);
      const strangerB = await connect(b, stranger);
      const mateA = await connect(a, mate);
      const mateB = await connect(b, mate);
      const aliceSocket = await connect(a, alice);

      await until(() => mine(mateA, aliceId).length > 0 && mine(mateB, aliceId).length > 0);
      expect(mine(mateA, aliceId)).toEqual(['online']);
      expect(mine(mateB, aliceId)).toEqual(['online']);

      await aliceSocket.close();
      await until(() => mine(mateA, aliceId).length === 2 && mine(mateB, aliceId).length === 2);
      await settle(3 * BATCH_MS);
      // The stranger got no presence frame about Alice, nor any frame naming her at all.
      expect(mine(strangerA, aliceId)).toEqual([]);
      expect(mine(strangerB, aliceId)).toEqual([]);
      expect(JSON.stringify(strangerA.frames)).not.toContain(`"userId":"${aliceId}"`);
    });

    it('scopes GET /api/presence to people who share a guild with the caller', async () => {
      const alice = unique('alice');
      const mate = unique('mate');
      const stranger = unique('stranger');
      const aliceId = await ensureUser(infra.db, alice);
      const strangerId = await ensureUser(infra.db, stranger);
      await guildOf([alice, mate]);
      await createGuildVia(stranger);
      await connect(b, alice);
      await connect(a, stranger);

      const asMate = await presenceOf(a, mate);
      expect(statusIn(asMate, aliceId)).toBe('online');
      expect(statusIn(asMate, strangerId)).toBeUndefined();
      const asStranger = await presenceOf(b, stranger);
      expect(statusIn(asStranger, aliceId)).toBeUndefined();
      expect(statusIn(asStranger, strangerId)).toBe('online');
    });

    it('also scopes the guild member list status', async () => {
      const alice = unique('alice');
      const mate = unique('mate');
      const aliceId = await ensureUser(infra.db, alice);
      const guildId = await guildOf([alice, mate]);
      await connect(a, alice);
      const members = (await api(b, mate)(`/api/guilds/${guildId}/members`)).body as {
        members: { id: string; status: string }[];
      };
      expect(members.members.find((m) => m.id === aliceId)?.status).toBe('online');
      expect(
        members.members.find((m) => m.status === 'online' && m.id !== aliceId),
      ).toBeUndefined();
    });

    it('delivers to a DM partner who no longer shares a guild, and to nobody else', async () => {
      const alice = unique('alice');
      const bob = unique('bob');
      const stranger = unique('stranger');
      const aliceId = await ensureUser(infra.db, alice);
      const bobId = await ensureUser(infra.db, bob);
      const guildId = await guildOf([alice, bob]);
      await createGuildVia(stranger);
      expect(
        (await api(a, alice)('/api/dms', { method: 'POST', body: { userId: bobId } })).status,
      ).toBeLessThan(300);
      expect((await api(a, bob)(`/api/guilds/${guildId}/leave`, { method: 'POST' })).status).toBe(
        204,
      );

      const bobSocket = await connect(b, bob);
      const strangerSocket = await connect(a, stranger);
      const aliceSocket = await connect(a, alice);
      await until(() => mine(bobSocket, aliceId).length === 1);
      expect(mine(bobSocket, aliceId)).toEqual(['online']);
      // And the other direction: Alice learns that Bob is online through the DM topic.
      await bobSocket.close();
      await until(() => mine(aliceSocket, bobId).includes('offline'));
      await settle(2 * BATCH_MS);
      expect(mine(strangerSocket, aliceId)).toEqual([]);
      expect(mine(strangerSocket, bobId)).toEqual([]);
      expect(statusIn(await presenceOf(a, alice), bobId)).toBeUndefined();
      await connect(a, bob);
      expect(statusIn(await presenceOf(b, alice), bobId)).toBe('online');
      expect(statusIn(await presenceOf(a, stranger), bobId)).toBeUndefined();
    });

    it('starts delivering when a user joins a guild and stops when they leave or are kicked', async () => {
      const owner = unique('owner');
      const joiner = unique('joiner');
      const ownerId = await ensureUser(infra.db, owner);
      const joinerId = await ensureUser(infra.db, joiner);
      const guild = await createGuildVia(owner);
      const ownerSocket = await connect(a, owner);
      const joinerSocket = await connect(b, joiner);
      await settle(3 * BATCH_MS);
      expect(mine(joinerSocket, ownerId)).toEqual([]);
      expect(statusIn(await presenceOf(b, joiner), ownerId)).toBeUndefined();

      await join(owner, guild.id, joiner);
      // The newcomer's snapshot has the owner, and the owner is told the newcomer is online.
      await joinerSocket.waitFor('guild.joined');
      expect(statusIn(await presenceOf(b, joiner), ownerId)).toBe('online');
      await until(() => mine(ownerSocket, joinerId).includes('online'));

      // Live: a later change reaches the newcomer without reconnecting.
      ownerSocket.send({ type: 'presence.set', status: 'dnd' });
      await until(() => mine(joinerSocket, ownerId).includes('dnd'));

      // Leaving ends delivery at once.
      expect(
        (await api(b, joiner)(`/api/guilds/${guild.id}/leave`, { method: 'POST' })).status,
      ).toBe(204);
      await joinerSocket.waitFor('guild.removed');
      const seen = updatesOf(joinerSocket).length;
      ownerSocket.send({ type: 'presence.set', status: 'idle' });
      await until(() => mine(ownerSocket, ownerId).includes('idle'));
      await settle(3 * BATCH_MS);
      expect(updatesOf(joinerSocket)).toHaveLength(seen);
      expect(statusIn(await presenceOf(b, joiner), ownerId)).toBeUndefined();

      // Rejoin, then be kicked.
      await join(owner, guild.id, joiner);
      expect(statusIn(await presenceOf(b, joiner), ownerId)).toBe('idle');
      expect(
        (await api(a, owner)(`/api/guilds/${guild.id}/members/${joinerId}`, { method: 'DELETE' }))
          .status,
      ).toBeLessThan(300);
      await until(() => joinerSocket.of('guild.removed').length === 2);
      const afterKick = updatesOf(joinerSocket).length;
      ownerSocket.send({ type: 'presence.set', status: 'online' });
      await until(() => mine(ownerSocket, ownerId).at(-1) === 'online');
      await settle(3 * BATCH_MS);
      expect(updatesOf(joinerSocket)).toHaveLength(afterKick);
    });

    it('starts delivering when a DM is created while both are connected', async () => {
      const alice = unique('alice');
      const bob = unique('bob');
      const aliceId = await ensureUser(infra.db, alice);
      const bobId = await ensureUser(infra.db, bob);
      const guildId = await guildOf([alice, bob]);
      const bobSocket = await connect(b, bob);
      const aliceSocket = await connect(a, alice);
      await until(() => mine(bobSocket, aliceId).length === 1);
      // Bob leaves the shared guild, so only a DM could connect them.
      expect((await api(b, bob)(`/api/guilds/${guildId}/leave`, { method: 'POST' })).status).toBe(
        204,
      );
      await bobSocket.waitFor('guild.removed');
      aliceSocket.send({ type: 'presence.set', status: 'idle' });
      await settle(4 * BATCH_MS);
      expect(mine(bobSocket, aliceId)).toEqual(['online']);

      // Both are in a second guild only for the DM to be created; then Bob leaves it too.
      const again = await createGuildVia(alice);
      await join(alice, again.id, bob);
      await bobSocket.waitFor('guild.joined');
      expect(
        (await api(a, alice)('/api/dms', { method: 'POST', body: { userId: bobId } })).status,
      ).toBeLessThan(300);
      await bobSocket.waitFor('channel.joined');
      expect((await api(b, bob)(`/api/guilds/${again.id}/leave`, { method: 'POST' })).status).toBe(
        204,
      );
      await bobSocket.waitFor('guild.removed', 2);
      aliceSocket.send({ type: 'presence.set', status: 'dnd' });
      await until(() => mine(bobSocket, aliceId).at(-1) === 'dnd');
    });
  });

  describe('batching', () => {
    it('sends one presence.batch per window, not before it ends, with every change in it', async () => {
      const slow = await infra.startApp({ ...FAST, PRESENCE_BATCH_MS: '600' });
      const owner = unique('owner');
      const mates = [unique('m1'), unique('m2'), unique('m3')];
      const ids = await Promise.all([owner, ...mates].map((l) => ensureUser(infra.db, l)));
      await guildOf([owner, ...mates]);
      const watcher = await TestSocket.connect(slow, owner);
      sockets.push(watcher);
      await watcher.waitFor('hello');
      await settle(900);
      const baseline = watcher.of('presence.batch').length;

      const started = Date.now();
      for (const mate of mates) sockets.push(await TestSocket.connect(slow, mate));
      await watcher.waitFor('presence.batch', baseline + 1);
      const elapsed = Date.now() - started;
      await settle(900);

      const batches = watcher.of('presence.batch').slice(baseline);
      expect(batches).toHaveLength(1);
      expect(batches[0]?.updates.map((u) => u.userId).sort()).toEqual([...ids.slice(1)].sort());
      expect(batches[0]?.updates.every((u) => u.status === 'online')).toBe(true);
      // Not before the window ends (the timer starts at the first change, a few ms after `started`).
      expect(elapsed).toBeGreaterThanOrEqual(500);
    });

    it('sends nothing for a flap that ends where it started, and the final state otherwise', async () => {
      const owner = unique('owner');
      const flapper = unique('flapper');
      const flapperId = await ensureUser(infra.db, flapper);
      await guildOf([owner, flapper]);
      const watcher = await connect(b, owner);
      const presence = new PresenceService(
        infra.redis,
        infra.db,
        new EventBus(infra.redis),
        { ttlMs: 60_000, sweepMs: 60_000 },
        noLog,
      );
      await presence.touch(flapperId, 'c1');
      await until(() => mine(watcher, flapperId).length === 1);
      await settle(2 * BATCH_MS);

      // Online -> offline -> online inside one window: the watcher already has "online".
      await presence.disconnect(flapperId, 'c1');
      await presence.touch(flapperId, 'c1');
      await settle(4 * BATCH_MS);
      expect(mine(watcher, flapperId)).toEqual(['online']);

      // Online -> offline -> online -> offline: the end state differs, so it is sent once.
      await presence.disconnect(flapperId, 'c1');
      await presence.touch(flapperId, 'c1');
      await presence.disconnect(flapperId, 'c1');
      await until(() => mine(watcher, flapperId).length === 2);
      await settle(2 * BATCH_MS);
      expect(mine(watcher, flapperId)).toEqual(['online', 'offline']);
    });

    it('a connected user sees a correct snapshot after reconnecting', async () => {
      const owner = unique('owner');
      const m1 = unique('m1');
      const m2 = unique('m2');
      const [, id1, id2] = await Promise.all([owner, m1, m2].map((l) => ensureUser(infra.db, l)));
      await guildOf([owner, m1, m2]);
      const first = await connect(a, owner);
      const s1 = await connect(b, m1);
      const s2 = await connect(a, m2);
      await until(() => mine(first, id1!).length === 1 && mine(first, id2!).length === 1);

      // The owner drops; while away, m1 goes offline and m2 goes dnd.
      await first.close();
      await s1.close();
      s2.send({ type: 'presence.set', status: 'dnd' });
      await settle(4 * BATCH_MS);

      // On reconnect the snapshot read after `hello` is exact, and later changes arrive as batches.
      const again = await connect(b, owner);
      const snapshot = await presenceOf(b, owner);
      expect(statusIn(snapshot, id1!)).toBeUndefined();
      expect(statusIn(snapshot, id2!)).toBe('dnd');
      s2.send({ type: 'presence.set', status: 'idle' });
      await until(() => mine(again, id2!).includes('idle'));
    });
  });

  describe('across two app instances', () => {
    it('announces online and offline to clients on every instance, once each', async () => {
      const login = unique('alice');
      const watcherLogin = unique('watcher');
      const userId = await ensureUser(infra.db, login);
      await guildOf([watcherLogin, login]);
      const watcher = await connect(b, watcherLogin);

      const first = await connect(a, login);
      const second = await connect(b, login);
      await until(() => mine(watcher, userId).length >= 1);
      await settle(300);
      expect(mine(watcher, userId)).toEqual(['online']);
      expect(statusIn(await presenceOf(a, watcherLogin), userId)).toBe('online');

      await first.close();
      await settle(300);
      expect(mine(watcher, userId)).toHaveLength(1);

      await second.close();
      await until(() => mine(watcher, userId).length === 2);
      expect(mine(watcher, userId)).toEqual(['online', 'offline']);
      expect(statusIn(await presenceOf(a, watcherLogin), userId)).toBeUndefined();
    });

    it('keeps a live connection online across many sweeps via heartbeats', async () => {
      const login = unique('steady');
      const watcherLogin = unique('watcher');
      const userId = await ensureUser(infra.db, login);
      await guildOf([watcherLogin, login]);
      const watcher = await connect(a, watcherLogin);
      const socket = await connect(a, login);
      await until(() => mine(watcher, userId).length === 1);
      await settle(3000);
      expect(mine(watcher, userId)).toEqual(['online']);
      await socket.close();
    });

    it('emits exactly one offline when a connection vanishes without a clean close', async () => {
      const login = unique('crashed');
      const watcherLogin = unique('watcher');
      const userId = await ensureUser(infra.db, login);
      await guildOf([watcherLogin, login]);
      const watcher = await connect(a, watcherLogin);
      // A connection registered by an instance that then died: it never heartbeats or closes.
      const doomed = new PresenceService(
        infra.redis,
        infra.db,
        new EventBus(infra.redis),
        { ttlMs: 1500, sweepMs: 60_000 },
        noLog,
      );
      await doomed.touch(userId, randomUUID());

      await until(() => mine(watcher, userId).length === 1);
      expect(mine(watcher, userId)).toEqual(['online']);

      await until(() => mine(watcher, userId).length === 2);
      await settle(1200);
      expect(mine(watcher, userId)).toEqual(['online', 'offline']);
    });
  });

  describe('chosen status', () => {
    it('shows invisible as offline and passes idle and dnd through', async () => {
      const login = unique('mood');
      const watcherLogin = unique('watcher');
      const userId = await ensureUser(infra.db, login);
      await guildOf([watcherLogin, login]);
      const watcher = await connect(b, watcherLogin);
      await connect(a, login);
      await until(() => mine(watcher, userId).length === 1);

      const call = api(a, login);
      const set = await call('/api/me', { method: 'PATCH', body: { status: 'dnd' } });
      expect((set.body as Me).status).toBe('dnd');
      await until(() => mine(watcher, userId).length === 2);
      expect(mine(watcher, userId)[1]).toBe('dnd');

      await call('/api/me', { method: 'PATCH', body: { status: 'invisible' } });
      await until(() => mine(watcher, userId).length === 3);
      expect(mine(watcher, userId)[2]).toBe('offline');
      expect(statusIn(await presenceOf(b, watcherLogin), userId)).toBeUndefined();
      expect(((await call('/api/me')).body as Me).status).toBe('invisible');

      await call('/api/me', { method: 'PATCH', body: { status: 'online' } });
      await until(() => mine(watcher, userId).length === 4);
      expect(mine(watcher, userId)[3]).toBe('online');
    });

    it('accepts presence.set over the WebSocket and rejects unknown statuses', async () => {
      const login = unique('ws-mood');
      const watcherLogin = unique('watcher');
      const userId = await ensureUser(infra.db, login);
      await guildOf([watcherLogin, login]);
      const watcher = await connect(a, watcherLogin);
      const socket = await connect(b, login);
      await until(() => mine(watcher, userId).length === 1);

      socket.send({ type: 'presence.set', status: 'idle' });
      await until(() => mine(watcher, userId).length === 2);
      expect(mine(watcher, userId)[1]).toBe('idle');

      socket.send({ type: 'presence.set', status: 'offline' });
      expect((await socket.waitFor('error'))[0]?.code).toBe('invalid_frame');
      expect(
        (await api(a, login)('/api/me', { method: 'PATCH', body: { status: 'away' } })).status,
      ).toBe(400);
    });
  });

  describe('automatic idleness is per connection', () => {
    /** A watcher, and a user with the given sockets, all in one guild. */
    const setup = async (name: string) => {
      const login = unique(name);
      const watcherLogin = unique('watcher');
      const userId = await ensureUser(infra.db, login);
      await guildOf([watcherLogin, login]);
      const watcher = await connect(a, watcherLogin);
      const first = await connect(a, login);
      await until(() => mine(watcher, userId).length === 1);
      const second = await connect(b, login);
      await settle(2 * BATCH_MS);
      return { login, userId, watcher, first, second, watcherLogin };
    };
    const seenAs = (watcher: TestSocket, userId: string) => mine(watcher, userId).at(-1);

    it('is idle only when every connection is idle, and any activity brings them back', async () => {
      const { userId, watcher, first, second, login } = await setup('auto');
      expect(mine(watcher, userId)).toEqual(['online']);

      first.send({ type: 'presence.activity', idle: true });
      await settle(3 * BATCH_MS);
      expect(mine(watcher, userId)).toEqual(['online']);

      second.send({ type: 'presence.activity', idle: true });
      await until(() => seenAs(watcher, userId) === 'idle');
      // The chosen status is untouched: automatic idleness is never persisted.
      expect(((await api(a, login)('/api/me')).body as Me).status).toBe('online');

      first.send({ type: 'presence.activity', idle: false });
      await until(() => seenAs(watcher, userId) === 'online');
      expect(mine(watcher, userId)).toEqual(['online', 'idle', 'online']);
    });

    it('keeps a chosen dnd whatever the connections report', async () => {
      const { userId, watcher, first, second } = await setup('dnd');
      first.send({ type: 'presence.set', status: 'dnd' });
      await until(() => seenAs(watcher, userId) === 'dnd');
      first.send({ type: 'presence.activity', idle: true });
      second.send({ type: 'presence.activity', idle: true });
      second.send({ type: 'presence.activity', idle: false });
      await settle(3 * BATCH_MS);
      expect(seenAs(watcher, userId)).toBe('dnd');

      // Back to online with both idle flags set: now the automatic part applies.
      first.send({ type: 'presence.activity', idle: true });
      second.send({ type: 'presence.activity', idle: true });
      first.send({ type: 'presence.set', status: 'online' });
      await until(() => seenAs(watcher, userId) === 'idle');
    });

    it('turns idle when the only active connection closes, and a new one is active', async () => {
      const { userId, watcher, first, second, login } = await setup('close');
      first.send({ type: 'presence.activity', idle: true });
      await settle(3 * BATCH_MS);
      expect(seenAs(watcher, userId)).toBe('online');

      await second.close();
      await until(() => seenAs(watcher, userId) === 'idle');

      // A reconnect is active until it says otherwise, so no stale idle survives it.
      const third = await connect(b, login);
      await until(() => seenAs(watcher, userId) === 'online');
      third.send({ type: 'presence.activity', idle: true });
      await until(() => seenAs(watcher, userId) === 'idle');
      third.send({ type: 'presence.activity', idle: false });
      await until(() => seenAs(watcher, userId) === 'online');
    });

    it('still accepts the old presence.set idle as a chosen status', async () => {
      const { userId, watcher, first, second, login } = await setup('legacy');
      first.send({ type: 'presence.set', status: 'idle' });
      await until(() => seenAs(watcher, userId) === 'idle');
      expect(((await api(a, login)('/api/me')).body as Me).status).toBe('idle');
      // Activity does not undo a chosen idle.
      second.send({ type: 'presence.activity', idle: false });
      await settle(3 * BATCH_MS);
      expect(seenAs(watcher, userId)).toBe('idle');
      first.send({ type: 'presence.set', status: 'online' });
      await until(() => seenAs(watcher, userId) === 'online');
    });

    it('scores the service script directly: only changes publish', async () => {
      const { userId, guildId } = await (async () => {
        const login = unique('script');
        const userId = await ensureUser(infra.db, login);
        const guildId = (await createGuildVia(login)).id;
        await listen(guildId);
        return { userId, guildId };
      })();
      const presence = new PresenceService(
        infra.redis,
        infra.db,
        new EventBus(infra.redis),
        { ttlMs: 60_000, sweepMs: 60_000 },
        noLog,
      );
      await presence.touch(userId, 'c1', { status: 'online' });
      await presence.touch(userId, 'c2', { status: 'online' });
      await presence.activity(userId, 'c1', true);
      await presence.activity(userId, 'c1', true);
      await presence.activity(userId, 'nope', true);
      await presence.activity(userId, 'c2', true);
      await presence.activity(userId, 'c2', true);
      await presence.disconnect(userId, 'c2');
      await presence.activity(userId, 'c1', false);
      await settle();
      expect(busEvents(guildId, userId).map((e) => e.status)).toEqual(['online', 'idle', 'online']);
    });
  });
});
