import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRESENCE_TOPIC, PresenceEvent, type PresenceResponse, type Me } from '@harmony/shared';
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
const FAST = { PRESENCE_TTL_MS: '1500', PRESENCE_HEARTBEAT_MS: '300', PRESENCE_SWEEP_MS: '300' };
const noLog = { warn: () => undefined };

describe('presence', () => {
  let infra: Infra;
  let a: TestApp;
  let b: TestApp;
  let listener: Redis;
  const events: PresenceEvent[] = [];
  const sockets: TestSocket[] = [];

  const forUser = (userId: string) => events.filter((e) => e.userId === userId);
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

  beforeAll(async () => {
    infra = createInfra();
    [a, b] = await Promise.all([
      infra.startApp({ ...FAST, MESSAGE_RATE_MAX: '1000' }),
      infra.startApp({ ...FAST, MESSAGE_RATE_MAX: '1000' }),
    ]);
    listener = infra.redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
    await listener.subscribe(PRESENCE_TOPIC);
    listener.on('message', (_topic, payload: string) => {
      events.push(PresenceEvent.parse(JSON.parse(payload)));
    });
  });

  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    listener.disconnect();
    await infra.stop();
  });

  describe('transition script', () => {
    // A long TTL so nothing expires while the transitions are exercised.
    const service = () =>
      new PresenceService(
        infra.redis,
        infra.db,
        new EventBus(infra.redis),
        { ttlMs: 60_000, sweepMs: 60_000 },
        noLog,
      );

    it('reports online once for many connections and offline once for the last', async () => {
      const userId = await ensureUser(infra.db, unique('lua'));
      const presence = service();

      await Promise.all([presence.touch(userId, 'c1'), presence.touch(userId, 'c2')]);
      await presence.touch(userId, 'c1');
      await settle();
      expect(forUser(userId).map((e) => e.status)).toEqual(['online']);

      await presence.disconnect(userId, 'c1');
      await settle();
      expect(forUser(userId)).toHaveLength(1);

      await presence.disconnect(userId, 'c2');
      await presence.disconnect(userId, 'c2');
      await presence.sweep();
      await settle();
      expect(forUser(userId).map((e) => e.status)).toEqual(['online', 'offline']);
    });

    it('decides each transition once when many callers race', async () => {
      const userId = await ensureUser(infra.db, unique('race'));
      const presences = Array.from({ length: 5 }, service);

      await Promise.all(presences.map((p, i) => p.touch(userId, `conn-${i}`)));
      await settle();
      expect(forUser(userId).map((e) => e.status)).toEqual(['online']);

      await Promise.all(presences.map((p, i) => p.disconnect(userId, `conn-${i}`)));
      await settle();
      expect(forUser(userId).map((e) => e.status)).toEqual(['online', 'offline']);
    });

    it('expires stale connections on sweep and only then reports offline', async () => {
      const userId = await ensureUser(infra.db, unique('stale'));
      const short = new PresenceService(
        infra.redis,
        infra.db,
        new EventBus(infra.redis),
        { ttlMs: 200, sweepMs: 60_000 },
        noLog,
      );
      await short.touch(userId, 'ghost');
      await short.sweep();
      await settle(50);
      expect(forUser(userId).map((e) => e.status)).toEqual(['online']);

      await settle(300);
      await Promise.all([short.sweep(), short.sweep(), short.sweep()]);
      await settle();
      expect(forUser(userId).map((e) => e.status)).toEqual(['online', 'offline']);
    });
  });

  describe('across two app instances', () => {
    it('announces online and offline to clients on every instance, once each', async () => {
      const login = unique('alice');
      const watcher = await connect(b, unique('watcher'));
      const userId = await ensureUser(infra.db, login);

      const first = await connect(a, login);
      const second = await connect(b, login);
      await watcher.waitFor('presence.updated');
      await settle(200);
      const seen = () => watcher.of('presence.updated').filter((f) => f.userId === userId);
      expect(seen().map((f) => f.status)).toEqual(['online']);

      const snapshot = (await api(a, unique('viewer'))('/api/presence')).body as PresenceResponse;
      expect(snapshot.presence).toContainEqual({ userId, status: 'online' });

      await first.close();
      await settle(200);
      expect(seen()).toHaveLength(1);

      await second.close();
      await until(() => seen().length === 2);
      expect(seen().map((f) => f.status)).toEqual(['online', 'offline']);
      const after = (await api(a, unique('viewer'))('/api/presence')).body as PresenceResponse;
      expect(after.presence.some((p) => p.userId === userId)).toBe(false);
    });

    it('keeps a live connection online across many sweeps via heartbeats', async () => {
      const login = unique('steady');
      const userId = await ensureUser(infra.db, login);
      const socket = await connect(a, login);
      await until(() => forUser(userId).length === 1);
      await settle(3000);
      expect(forUser(userId).map((e) => e.status)).toEqual(['online']);
      await socket.close();
    });

    it('emits exactly one offline when a connection vanishes without a clean close', async () => {
      const userId = await ensureUser(infra.db, unique('crashed'));
      const watcher = await connect(a, unique('watcher'));
      // A connection registered by an instance that then died: it never heartbeats or closes.
      const doomed = new PresenceService(
        infra.redis,
        infra.db,
        new EventBus(infra.redis),
        { ttlMs: 1500, sweepMs: 60_000 },
        noLog,
      );
      await doomed.touch(userId, randomUUID());

      await until(() => watcher.of('presence.updated').some((f) => f.userId === userId));
      const mine = () => watcher.of('presence.updated').filter((f) => f.userId === userId);
      expect(mine().map((f) => f.status)).toEqual(['online']);

      await until(() => mine().length === 2);
      await settle(1200);
      expect(mine().map((f) => f.status)).toEqual(['online', 'offline']);
    });
  });

  describe('chosen status', () => {
    it('shows invisible as offline and passes idle and dnd through', async () => {
      const login = unique('mood');
      const userId = await ensureUser(infra.db, login);
      const watcher = await connect(b, unique('watcher'));
      await connect(a, login);
      const mine = () => watcher.of('presence.updated').filter((f) => f.userId === userId);
      await until(() => mine().length === 1);

      const call = api(a, login);
      const set = await call('/api/me', { method: 'PATCH', body: { status: 'dnd' } });
      expect((set.body as Me).status).toBe('dnd');
      await until(() => mine().length === 2);
      expect(mine()[1]?.status).toBe('dnd');

      await call('/api/me', { method: 'PATCH', body: { status: 'invisible' } });
      await until(() => mine().length === 3);
      expect(mine()[2]?.status).toBe('offline');
      const hidden = (await api(b, unique('viewer'))('/api/presence')).body as PresenceResponse;
      expect(hidden.presence.some((p) => p.userId === userId)).toBe(false);
      expect(((await call('/api/me')).body as Me).status).toBe('invisible');

      await call('/api/me', { method: 'PATCH', body: { status: 'online' } });
      await until(() => mine().length === 4);
      expect(mine()[3]?.status).toBe('online');
    });

    it('accepts presence.set over the WebSocket and rejects unknown statuses', async () => {
      const login = unique('ws-mood');
      const userId = await ensureUser(infra.db, login);
      const watcher = await connect(a, unique('watcher'));
      const socket = await connect(b, login);
      const mine = () => watcher.of('presence.updated').filter((f) => f.userId === userId);
      await until(() => mine().length === 1);

      socket.send({ type: 'presence.set', status: 'idle' });
      await until(() => mine().length === 2);
      expect(mine()[1]?.status).toBe('idle');

      socket.send({ type: 'presence.set', status: 'offline' });
      expect((await socket.waitFor('error'))[0]?.code).toBe('invalid_frame');
      expect(
        (await api(a, login)('/api/me', { method: 'PATCH', body: { status: 'away' } })).status,
      ).toBe(400);
    });
  });
});
