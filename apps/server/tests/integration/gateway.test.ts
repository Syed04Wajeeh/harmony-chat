import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import type { InteractionPayload } from '@harmony/shared';
import { loadWorkerConfig } from '../../src/config.js';
import { EventWorker } from '../../src/events/worker.js';
import { GatewayBus } from '../../src/gateway/bus.js';
import {
  TestSocket,
  api,
  createChannel,
  createGuild,
  createInfra,
  ensureUser,
  settle,
  type Infra,
  type TestApp,
} from './support/harness.js';
import { addBotToGuild, bare, botApi, createBot } from './support/bots.js';

const uid = () => randomUUID().slice(0, 8);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('bots on the gateway', () => {
  let infra: Infra;
  let a: TestApp;
  let b: TestApp;
  const sockets: TestSocket[] = [];
  const workers: EventWorker[] = [];

  beforeAll(async () => {
    infra = createInfra();
    const env = {
      INTERACTION_DEADLINE_MS: '1500',
      MESSAGE_RATE_MAX: '500',
      OUTBOUND_PRIVATE_ALLOWLIST: '127.0.0.1',
    };
    [a, b] = await Promise.all([infra.startApp(env), infra.startApp(env)]);
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
    await Promise.all(sockets.splice(0).map((socket) => socket.close()));
  });
  afterAll(async () => {
    await infra.stop();
  });

  const bus = () => new GatewayBus(infra.redis, { ttlMs: 30_000, maxConnections: 3 });

  /** Claims only these bots' deliveries: other test files run workers on the same database. */
  async function startWorker(botIds: string[], overrides: Record<string, string> = {}) {
    const config = loadWorkerConfig({
      DATABASE_URL: inject('databaseUrl'),
      LOG_LEVEL: 'silent',
      WORKER_POLL_MS: '50',
      WORKER_BATCH_WINDOW_MS: '0',
      GATEWAY_ACK_TIMEOUT_MS: '400',
      ...overrides,
    });
    const worker = new EventWorker(
      infra.db,
      config,
      silent,
      () => 0.999,
      () => undefined,
      bus(),
    );
    worker.claimOnly = botIds;
    workers.push(worker);
    await worker.start();
    return worker;
  }

  async function connectBot(target: TestApp, token: string): Promise<TestSocket> {
    const socket = await TestSocket.connectWith(target, { authorization: `Bot ${token}` });
    sockets.push(socket);
    await socket.waitFor('hello');
    return socket;
  }

  async function world(botBody: Record<string, unknown> = {}) {
    const owner = `owner-${uid()}@example.com`;
    const alice = `alice-${uid()}@example.com`;
    await ensureUser(infra.db, owner, { admin: true });
    const guildId = await createGuild(infra.db, owner, [alice]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const created = await createBot(a, owner, {
      scopes: ['messages.read', 'messages.write', 'commands', 'events'],
      eventTypes: ['message.created'],
      ...botBody,
    });
    await addBotToGuild(a, owner, guildId, created.bot.id);
    const asBot = botApi(a, created.token);
    const put = await api(a, owner)(`/api/bots/${created.bot.id}/guilds/${guildId}/commands`, {
      method: 'PUT',
      body: [
        {
          name: 'echo',
          description: 'Echo',
          options: [{ name: 'text', description: 'Text', type: 'string', required: true }],
        },
      ],
    });
    expect(put.status).toBe(200);
    const aliceA = await TestSocket.connect(a, alice);
    sockets.push(aliceA);
    await aliceA.subscribe(channelId);
    const invoke = (target: TestApp, body: unknown) =>
      api(target, alice)(`/api/channels/${channelId}/commands`, { method: 'POST', body });
    const say = async (content: string) => {
      const res = await api(a, alice)(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        body: { content },
      });
      expect(res.status).toBe(201);
    };
    const deliveries = () =>
      infra.db
        .selectFrom('event_deliveries')
        .selectAll()
        .where('bot_id', '=', created.bot.id)
        .orderBy('seq')
        .execute();
    return { owner, alice, guildId, channelId, aliceA, invoke, say, deliveries, asBot, ...created };
  }

  const echo = { name: 'echo', options: { text: 'hi' } };
  const created = (socket: TestSocket) => socket.of('interaction.create');
  const first = async (socket: TestSocket) => {
    await waitUntil(() => created(socket).length > 0);
    return created(socket)[0]?.interaction as InteractionPayload;
  };
  async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition');
      await sleep(15);
    }
  }

  it('reports the delivery mode of each bot', async () => {
    const w = await world();
    expect(w.bot.delivery).toEqual({ interactions: 'gateway', events: 'gateway' });
    const http = await createBot(a, w.owner, {
      scopes: ['commands', 'events'],
      interactionsUrl: 'http://127.0.0.1:9/i',
      eventsUrl: 'http://127.0.0.1:9/e',
    });
    expect(http.bot.delivery).toEqual({ interactions: 'http', events: 'http' });
    const plain = await createBot(a, w.owner, {});
    expect(plain.bot.delivery).toEqual({ interactions: 'off', events: 'off' });
  });

  describe('interactions', () => {
    it('round-trips a command on one instance', async () => {
      const w = await world();
      const bot = await connectBot(a, w.token);
      expect((await w.invoke(a, { ...echo, nonce: 'n1' })).status).toBe(202);
      const payload = await first(bot);
      expect(payload).toMatchObject({
        type: 'command',
        command: { name: 'echo', options: { text: 'hi' } },
        channelId: w.channelId,
      });
      expect(payload.token.length).toBeGreaterThan(20);

      bot.send({
        type: 'interaction.respond',
        interactionId: payload.id,
        token: payload.token,
        response: { type: 'message', content: 'hi back', ephemeral: true },
      });
      const [eph] = await w.aliceA.waitFor('interaction.ephemeral');
      expect(eph).toMatchObject({ content: 'hi back', nonce: 'n1', botId: w.bot.id });
    });

    it('routes the answer back when the bot is on another instance', async () => {
      const w = await world();
      const bot = await connectBot(b, w.token);
      await w.invoke(a, { ...echo, nonce: 'n2' });
      const payload = await first(bot);
      bot.send({
        type: 'interaction.respond',
        interactionId: payload.id,
        token: payload.token,
        response: { type: 'message', content: 'public answer' },
      });
      const [message] = await w.aliceA.waitFor('message.created');
      expect(message?.message).toMatchObject({
        content: 'public answer',
        author: { id: w.bot.id },
      });
      expect(w.aliceA.of('interaction.failed')).toHaveLength(0);

      // The same holds the other way round: the bot on A, the invocation on B.
      const bot2 = await connectBot(a, w.token);
      await w.invoke(b, { ...echo, nonce: 'n3' });
      const second = await first(bot2);
      bot2.send({
        type: 'interaction.respond',
        interactionId: second.id,
        token: second.token,
        response: { type: 'message', content: 'ephemeral', ephemeral: true },
      });
      await w.aliceA.waitFor('interaction.ephemeral');
    });

    it('fails fast with unreachable when the bot is offline', async () => {
      const w = await world();
      const started = Date.now();
      await w.invoke(a, { ...echo, nonce: 'n4' });
      const [failed] = await w.aliceA.waitFor('interaction.failed');
      expect(failed).toMatchObject({ reason: 'unreachable', nonce: 'n4' });
      // The deadline is 1500 ms; nothing waits for it.
      expect(Date.now() - started).toBeLessThan(700);
    });

    it('is unreachable again once the bot disconnects', async () => {
      const w = await world();
      const bot = await connectBot(b, w.token);
      await bot.close();
      await settle(100);
      await w.invoke(a, { ...echo, nonce: 'n5' });
      const [failed] = await w.aliceA.waitFor('interaction.failed');
      expect(failed?.reason).toBe('unreachable');
    });

    it('supports deferred answers and the REST follow-up', async () => {
      const w = await world();
      const bot = await connectBot(b, w.token);
      await w.invoke(a, { ...echo, nonce: 'n6' });
      const payload = await first(bot);
      bot.send({
        type: 'interaction.respond',
        interactionId: payload.id,
        token: payload.token,
        response: { type: 'deferred' },
      });
      await w.aliceA.waitFor('interaction.pending');
      const followup = await bare(a, `/api/interactions/${payload.id}/${payload.token}/followup`, {
        body: { content: 'later' },
      });
      expect(followup.status).toBe(201);
      const [message] = await w.aliceA.waitFor('message.created');
      expect(message?.message.content).toBe('later');
    });

    it('times out when the bot never answers, and refuses a late answer', async () => {
      const w = await world();
      const bot = await connectBot(a, w.token);
      await w.invoke(a, { ...echo, nonce: 'n7' });
      const payload = await first(bot);
      const [failed] = await w.aliceA.waitFor('interaction.failed', 1, 4000);
      expect(failed?.reason).toBe('timeout');
      bot.send({
        type: 'interaction.respond',
        interactionId: payload.id,
        token: payload.token,
        response: { type: 'message', content: 'late' },
      });
      const [error] = await bot.waitFor('error');
      expect(error?.code).toBe('interaction_not_pending');
    });

    it('accepts only the first answer and rejects a wrong token', async () => {
      const w = await world();
      const bot = await connectBot(a, w.token);
      await w.invoke(a, { ...echo, nonce: 'n8' });
      const payload = await first(bot);
      bot.send({
        type: 'interaction.respond',
        interactionId: payload.id,
        token: 'x'.repeat(43),
        response: { type: 'message', content: 'forged' },
      });
      expect((await bot.waitFor('error'))[0]?.code).toBe('invalid_token');
      const answer = {
        type: 'interaction.respond',
        interactionId: payload.id,
        token: payload.token,
        response: { type: 'message', content: 'once', ephemeral: true },
      };
      bot.send(answer);
      bot.send(answer);
      await w.aliceA.waitFor('interaction.ephemeral');
      expect((await bot.waitFor('error', 2))[1]?.code).toBe('interaction_not_pending');
      await settle();
      expect(w.aliceA.of('interaction.ephemeral')).toHaveLength(1);
    });

    it('does not let another bot answer', async () => {
      const w = await world();
      const bot = await connectBot(a, w.token);
      const other = await createBot(a, w.owner, { scopes: ['commands'] });
      const impostor = await connectBot(a, other.token);
      await w.invoke(a, { ...echo, nonce: 'n9' });
      const payload = await first(bot);
      impostor.send({
        type: 'interaction.respond',
        interactionId: payload.id,
        token: payload.token,
        response: { type: 'message', content: 'mine now' },
      });
      expect((await impostor.waitFor('error'))[0]?.code).toBe('invalid_token');
    });

    it('marks an invalid response like the HTTP path does', async () => {
      const w = await world();
      const bot = await connectBot(a, w.token);
      await w.invoke(a, { ...echo, nonce: 'n10' });
      const payload = await first(bot);
      bot.send({
        type: 'interaction.respond',
        interactionId: payload.id,
        token: payload.token,
        response: { type: 'nonsense' },
      });
      const [failed] = await w.aliceA.waitFor('interaction.failed');
      expect(failed?.reason).toBe('invalid_response');
    });

    it('delivers to the newest of several sockets', async () => {
      const w = await world();
      const older = await connectBot(a, w.token);
      await sleep(5);
      const newer = await connectBot(b, w.token);
      await w.invoke(a, { ...echo, nonce: 'n11' });
      await first(newer);
      await settle();
      expect(created(older)).toHaveLength(0);
      expect(created(newer)).toHaveLength(1);
    });
  });

  describe('events', () => {
    it('numbers events per bot, accepts acks and replays what was not acknowledged', async () => {
      const w = await world();
      await startWorker([w.bot.id]);
      const first = await connectBot(a, w.token);
      await w.say('one');
      await w.say('two');
      await waitUntil(() => first.of('event').length >= 2);
      const frames = first.of('event');
      expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
      expect(frames[0]?.event).toMatchObject({ type: 'message.created', guildId: w.guildId });
      expect(frames[0]?.deliveryId).toMatch(/^\d+$/);

      first.send({ type: 'event.ack', seq: 1 });
      await waitUntil(async () => (await w.deliveries())[0]?.status === 'succeeded');
      expect((await w.deliveries())[1]?.status).toBe('pending');
      await first.close();

      // Offline: the worker leaves the backlog alone and does not burn attempts.
      await w.say('three');
      await settle(300);
      const rows = await w.deliveries();
      expect(rows.map((row) => [Number(row.seq), row.status])).toEqual([
        [1, 'succeeded'],
        [2, 'pending'],
        [3, 'pending'],
      ]);
      expect(rows[2]?.attempts).toBe(0);

      const second = await connectBot(b, w.token);
      second.send({ type: 'resume', lastSeq: 1 });
      const [resumed] = await second.waitFor('resumed');
      expect(resumed).toMatchObject({ lastSeq: 1, replayed: 2 });
      // At least once: the worker may also send 3 live the moment the bot is online, before
      // the replay, so check what arrived rather than how often.
      const seen = () => new Set(second.of('event').map((frame) => frame.seq));
      await waitUntil(() => seen().has(2) && seen().has(3));
      expect([...seen()].sort()).toEqual([2, 3]);

      second.send({ type: 'event.ack', seq: 3 });
      await waitUntil(async () =>
        (await w.deliveries()).every((row) => row.status === 'succeeded'),
      );
      // Longer than the ack timeout: nothing is sent again after an ack.
      const before = second.of('event').length;
      await settle(900);
      expect(second.of('event')).toHaveLength(before);
      await w.say('four');
      await waitUntil(() => seen().has(4));
      expect(second.of('event').at(-1)?.seq).toBe(4);
    });

    it('treats a resume cursor as an acknowledgement and replays nothing more', async () => {
      const w = await world();
      await startWorker([w.bot.id]);
      const bot = await connectBot(a, w.token);
      await w.say('a');
      await w.say('b');
      await waitUntil(() => bot.of('event').length >= 2);
      await bot.close();
      const again = await connectBot(a, w.token);
      again.send({ type: 'resume', lastSeq: 2 });
      expect((await again.waitFor('resumed'))[0]?.replayed).toBe(0);
      await settle(900);
      expect(again.of('event')).toHaveLength(0);
      expect((await w.deliveries()).map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
    });

    it('sends an unacknowledged event again after the ack timeout, then dead-letters it', async () => {
      const w = await world();
      await startWorker([w.bot.id], { GATEWAY_ACK_TIMEOUT_MS: '150', DELIVERY_MAX_ATTEMPTS: '2' });
      const bot = await connectBot(a, w.token);
      await w.say('ignored');
      await waitUntil(async () => (await w.deliveries())[0]?.status === 'dead', 8000);
      expect(bot.of('event').map((frame) => frame.seq)).toEqual([1, 1]);
      expect((await w.deliveries())[0]?.last_error).toContain('not acknowledged');
    });

    it('dead-letters old and excess unacknowledged events when pruning', async () => {
      const w = await world();
      const worker = await startWorker([w.bot.id], {
        GATEWAY_BACKLOG_MAX: '2',
        GATEWAY_EVENT_TTL_MS: '3000',
      });
      for (const text of ['1', '2', '3', '4']) await w.say(text);
      await waitUntil(async () => (await w.deliveries()).length === 4);
      await worker.deadLetterGateway();
      expect((await w.deliveries()).map((row) => row.status)).toEqual([
        'dead',
        'dead',
        'pending',
        'pending',
      ]);
      await sleep(3100);
      await worker.deadLetterGateway();
      expect((await w.deliveries()).map((row) => row.status)).toEqual([
        'dead',
        'dead',
        'dead',
        'dead',
      ]);
    });

    it('keeps sequence numbers separate per bot and strictly increasing under parallel workers', async () => {
      const w = await world();
      const other = await createBot(a, w.owner, {
        scopes: ['messages.read', 'events'],
        eventTypes: ['message.created'],
      });
      await addBotToGuild(a, w.owner, w.guildId, other.bot.id);
      await startWorker([w.bot.id, other.bot.id]);
      await startWorker([w.bot.id, other.bot.id]);
      for (const text of ['1', '2', '3', '4', '5']) await w.say(text);
      const seqs = async (botId: string) =>
        (
          await infra.db
            .selectFrom('event_deliveries')
            .select('seq')
            .where('bot_id', '=', botId)
            .orderBy('event_id')
            .execute()
        ).map((row) => Number(row.seq));
      await waitUntil(async () => (await seqs(w.bot.id)).length === 5);
      expect(await seqs(w.bot.id)).toEqual([1, 2, 3, 4, 5]);
      expect(await seqs(other.bot.id)).toEqual([1, 2, 3, 4, 5]);
    });

    it('leaves HTTP bots without a sequence number', async () => {
      const w = await world({ eventsUrl: 'http://127.0.0.1:9/events' });
      await startWorker([w.bot.id]);
      await w.say('http');
      await waitUntil(async () => (await w.deliveries()).length === 1);
      expect((await w.deliveries())[0]?.seq).toBeNull();
    });
  });

  describe('auth and limits', () => {
    it('enforces scopes per frame', async () => {
      const commandsOnly = await world({ scopes: ['commands'], eventTypes: [] });
      const events = await connectBot(a, commandsOnly.token);
      events.send({ type: 'event.ack', seq: 1 });
      events.send({ type: 'resume', lastSeq: 0 });
      expect((await events.waitFor('error', 2)).map((error) => error.code)).toEqual([
        'missing_scope',
        'missing_scope',
      ]);

      const eventsOnly = await world({ scopes: ['events'] });
      const socket = await connectBot(a, eventsOnly.token);
      socket.send({
        type: 'interaction.respond',
        interactionId: '1',
        token: 'x',
        response: { type: 'deferred' },
      });
      expect((await socket.waitFor('error'))[0]?.code).toBe('missing_scope');
    });

    it('keeps the gateway frames away from humans', async () => {
      const w = await world();
      w.aliceA.send({ type: 'event.ack', seq: 1 });
      w.aliceA.send({ type: 'resume', lastSeq: 0 });
      const errors = await w.aliceA.waitFor('error', 2);
      expect(errors.map((error) => error.code)).toEqual(['bot_only', 'bot_only']);
    });

    it('does not register a bot without commands or events as a receiver', async () => {
      const w = await world({ scopes: ['messages.read', 'messages.write'], eventTypes: [] });
      await connectBot(a, w.token);
      expect(await bus().pick(w.bot.id)).toBeNull();
    });

    it('limits the sockets a bot can hold', async () => {
      const limited = await infra.startApp({ GATEWAY_MAX_CONNECTIONS: '2' });
      const w = await world();
      const one = await connectBot(limited, w.token);
      await connectBot(limited, w.token);
      const third = await TestSocket.connectWith(limited, { authorization: `Bot ${w.token}` });
      sockets.push(third);
      const [error] = await third.waitFor('error');
      expect(error?.code).toBe('too_many_connections');
      await waitUntil(() => third.socket.readyState === third.socket.CLOSED);
      expect(third.of('hello')).toHaveLength(0);

      // A freed slot can be taken again.
      await one.close();
      await settle(100);
      const again = await connectBot(limited, w.token);
      expect(again.of('hello')).toHaveLength(1);
    });
  });
});
