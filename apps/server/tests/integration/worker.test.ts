import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Delivery, EventEnvelope } from '@harmony/shared';
import { verifySignature } from '@harmony/shared/signature';
import { loadWorkerConfig } from '../../src/config.js';
import { EventWorker } from '../../src/events/worker.js';
import {
  api,
  createChannel,
  createGuild,
  createInfra,
  ensureUser,
  settle,
  type Infra,
  type TestApp,
} from './support/harness.js';
import { Receiver, addBotToGuild, createBot, type Received } from './support/bots.js';

const uid = () => randomUUID().slice(0, 8);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('event delivery worker', () => {
  let infra: Infra;
  let target: TestApp;
  let receiver: Receiver;
  const workers: EventWorker[] = [];

  beforeAll(async () => {
    infra = createInfra();
    receiver = await Receiver.start();
    target = await infra.startApp({
      OUTBOUND_PRIVATE_ALLOWLIST: '127.0.0.1',
      MESSAGE_RATE_MAX: '500',
    });
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  });
  afterAll(async () => {
    await infra.stop();
    await receiver.stop();
  });

  const config = (overrides: Record<string, string> = {}) =>
    loadWorkerConfig({
      DATABASE_URL: inject('databaseUrl'),
      LOG_LEVEL: 'silent',
      OUTBOUND_PRIVATE_ALLOWLIST: '127.0.0.1',
      WORKER_POLL_MS: '50',
      DELIVERY_TIMEOUT_MS: '1500',
      DELIVERY_BACKOFF_BASE_MS: '300',
      DELIVERY_BACKOFF_CAP_MS: '5000',
      DELIVERY_MAX_ATTEMPTS: '3',
      ...overrides,
    });

  async function startWorker(overrides: Record<string, string> = {}, random = () => 0.999) {
    const worker = new EventWorker(infra.db, config(overrides), silent, random);
    workers.push(worker);
    await worker.start();
    return worker;
  }

  async function world(botBody: Record<string, unknown> = {}) {
    const owner = `owner-${uid()}@example.com`;
    await ensureUser(infra.db, owner, { admin: true });
    const guildId = await createGuild(infra.db, owner);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const path = `/${uid()}`;
    const created = await createBot(target, owner, {
      scopes: ['events', 'messages.read'],
      eventsUrl: `${receiver.url}${path}`,
      eventTypes: ['message.created'],
      ...botBody,
    });
    await addBotToGuild(target, owner, guildId, created.bot.id);
    const send = async (content: string) => {
      const res = await api(target, owner)(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        body: { content },
      });
      expect(res.status).toBe(201);
    };
    const mine = (): Received[] => receiver.requests.filter((r) => r.path === path);
    const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const deliveries = () =>
      infra.db
        .selectFrom('event_deliveries')
        .selectAll()
        .where('bot_id', '=', created.bot.id)
        .orderBy('id')
        .execute();
    return { owner, guildId, channelId, path, send, mine, waitFor, deliveries, ...created };
  }

  const reply = (status: number | ((n: number) => number), delayMs = 0) => {
    let calls = 0;
    receiver.handler = () => {
      calls += 1;
      return { status: typeof status === 'number' ? status : status(calls), delayMs };
    };
  };

  it('delivers a signed envelope with an idempotency header', async () => {
    const w = await world();
    reply(200);
    await startWorker();
    await w.send('hello bots');
    await w.waitFor(() => w.mine().length === 1);

    const request = w.mine()[0] as Received;
    expect(request.headers['content-type']).toContain('application/json');
    expect(
      verifySignature({
        secret: w.signingSecret,
        timestamp: request.headers['x-harmony-timestamp'] as string,
        signature: request.headers['x-harmony-signature'] as string,
        body: request.body,
      }),
    ).toBe(true);
    const envelope = JSON.parse(request.body) as EventEnvelope & {
      data: { message: { content: string } };
    };
    expect(envelope).toMatchObject({ type: 'message.created', guildId: w.guildId });
    expect(envelope.id).toMatch(/^\d+$/);
    expect(new Date(envelope.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(envelope.data.message.content).toBe('hello bots');

    await w.waitFor(async () => (await w.deliveries())[0]?.status === 'succeeded');
    const [delivery] = await w.deliveries();
    expect(request.headers['x-harmony-delivery-id']).toBe(delivery?.id);
    expect(delivery).toMatchObject({ attempts: 1, last_status_code: 200, last_error: null });
    expect(delivery?.delivered_at).toBeInstanceOf(Date);
  });

  it('delivers only subscribed types, and only for guilds and channels the bot belongs to', async () => {
    const w = await world({ eventTypes: ['message.created', 'guild.member_joined'] });
    reply(200);
    await startWorker();

    const privateChannel = await createChannel(infra.db, [w.owner], {
      guildId: w.guildId,
      createdBy: w.owner,
      private: true,
    });
    await api(target, w.owner)(`/api/channels/${privateChannel}/messages`, {
      method: 'POST',
      body: { content: 'secret chatter' },
    });
    const otherOwner = `other-${uid()}@example.com`;
    const otherChannel = await createChannel(infra.db, [otherOwner]);
    await api(target, otherOwner)(`/api/channels/${otherChannel}/messages`, {
      method: 'POST',
      body: { content: 'other guild' },
    });
    const sent = await api(target, w.owner)(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      body: { content: 'public one' },
    });
    await api(target, w.owner)(`/api/messages/${(sent.body as { id: string }).id}`, {
      method: 'PATCH',
      body: { content: 'edited (not subscribed)' },
    });

    const joiner = `joiner-${uid()}@example.com`;
    await ensureUser(infra.db, joiner);
    const invite = await api(target, w.owner)(`/api/guilds/${w.guildId}/invites`, {
      method: 'POST',
      body: {},
    });
    await api(target, joiner)(`/api/invites/${(invite.body as { code: string }).code}/accept`, {
      method: 'POST',
    });

    await w.waitFor(() => w.mine().length >= 3);
    await settle(400);
    const types = w.mine().map((r) => (JSON.parse(r.body) as EventEnvelope).type);
    expect(types.sort()).toEqual(['guild.member_joined', 'guild.member_joined', 'message.created']);
    const bodies = w
      .mine()
      .map((r) => r.body)
      .join('\n');
    expect(bodies).not.toContain('secret chatter');
    expect(bodies).not.toContain('other guild');
    expect(bodies).not.toContain('edited (not subscribed)');
  });

  it('withholds message events from bots lacking messages.read', async () => {
    const w = await world({
      scopes: ['events'],
      eventTypes: ['message.created', 'guild.member_joined'],
    });
    reply(200);
    await startWorker();
    await w.send('invisible to this bot');
    const joiner = `joiner-${uid()}@example.com`;
    await ensureUser(infra.db, joiner);
    const invite = await api(target, w.owner)(`/api/guilds/${w.guildId}/invites`, {
      method: 'POST',
      body: {},
    });
    await api(target, joiner)(`/api/invites/${(invite.body as { code: string }).code}/accept`, {
      method: 'POST',
    });
    await w.waitFor(() => w.mine().length >= 2);
    await settle(300);
    expect(w.mine().map((r) => (JSON.parse(r.body) as EventEnvelope).type)).not.toContain(
      'message.created',
    );
  });

  it('retries failures with exponential backoff and a stable delivery id', async () => {
    const w = await world();
    reply((n) => (n <= 2 ? 500 : 200));
    await startWorker();
    await w.send('flaky');
    await w.waitFor(async () => (await w.deliveries())[0]?.status === 'succeeded');

    const attempts = w.mine();
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((r) => r.headers['x-harmony-delivery-id'])).size).toBe(1);
    // random() is pinned near 1, so delays sit just under base * 2^(n-1): ~300ms, then ~600ms.
    expect(attempts[1]!.at - attempts[0]!.at).toBeGreaterThanOrEqual(250);
    expect(attempts[2]!.at - attempts[1]!.at).toBeGreaterThanOrEqual(550);
    expect((await w.deliveries())[0]).toMatchObject({ attempts: 3, last_status_code: 200 });
  });

  it('marks the delivery failed with a future retry time between attempts', async () => {
    const w = await world();
    reply(503);
    await startWorker({ DELIVERY_BACKOFF_BASE_MS: '2000' });
    await w.send('down for now');
    await w.waitFor(async () => (await w.deliveries())[0]?.status === 'failed');
    const [delivery] = await w.deliveries();
    expect(delivery).toMatchObject({ attempts: 1, last_status_code: 503, last_error: 'HTTP 503' });
    expect(delivery!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('goes dead after the maximum attempts, and redeliver revives it', async () => {
    const w = await world();
    reply(500);
    await startWorker({ DELIVERY_BACKOFF_BASE_MS: '20', DELIVERY_BACKOFF_CAP_MS: '40' });
    await w.send('doomed');
    await w.waitFor(async () => (await w.deliveries())[0]?.status === 'dead');
    expect(w.mine()).toHaveLength(3);
    const [dead] = await w.deliveries();
    expect(dead).toMatchObject({ attempts: 3, last_status_code: 500 });

    const log = await api(target, w.owner)(`/api/bots/${w.bot.id}/deliveries?status=dead`);
    const entries = (log.body as { deliveries: Delivery[] }).deliveries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: dead!.id,
      status: 'dead',
      eventType: 'message.created',
      attempts: 3,
    });

    reply(200);
    const redeliver = await api(target, w.owner)(
      `/api/bots/${w.bot.id}/deliveries/${dead!.id}/redeliver`,
      { method: 'POST' },
    );
    expect(redeliver.status).toBe(202);
    await w.waitFor(async () => (await w.deliveries())[0]?.status === 'succeeded');
    expect(w.mine()).toHaveLength(4);
    expect(new Set(w.mine().map((r) => r.headers['x-harmony-delivery-id'])).size).toBe(1);

    const stranger = `stranger-${uid()}@example.com`;
    await ensureUser(infra.db, stranger);
    const denied = await api(target, stranger)(
      `/api/bots/${w.bot.id}/deliveries/${dead!.id}/redeliver`,
      { method: 'POST' },
    );
    expect(denied.status).toBe(404);
    expect((await api(target, stranger)(`/api/bots/${w.bot.id}/deliveries`)).status).toBe(404);
  });

  it('does not follow redirects', async () => {
    const w = await world();
    receiver.handler = () => ({ status: 302 });
    await startWorker({ DELIVERY_BACKOFF_BASE_MS: '20', DELIVERY_BACKOFF_CAP_MS: '40' });
    await w.send('redirect me');
    await w.waitFor(async () => (await w.deliveries())[0]?.status === 'dead');
    expect((await w.deliveries())[0]?.last_error).toBe('HTTP 302');
  });

  it('never delivers the same delivery twice when two workers run', async () => {
    const w = await world();
    reply(200, 30);
    const total = 24;
    for (let i = 0; i < total; i++) await w.send(`burst ${i}`);
    await Promise.all([
      startWorker({ DELIVERY_BATCH_SIZE: '4' }),
      startWorker({ DELIVERY_BATCH_SIZE: '4' }),
    ]);
    await w.waitFor(
      async () => (await w.deliveries()).filter((d) => d.status === 'succeeded').length === total,
    );
    await settle(400);
    const ids = w.mine().map((r) => r.headers['x-harmony-delivery-id']);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect((await w.deliveries()).every((d) => d.attempts === 1)).toBe(true);
  });

  it('refuses private targets at delivery time for non-admin owners', async () => {
    const w = await world();
    reply(200);
    await infra.db
      .updateTable('users')
      .set({ is_admin: false })
      .where('login', '=', w.owner)
      .execute();
    await startWorker();
    await w.send('should not leave the server');
    await w.waitFor(async () => (await w.deliveries())[0]?.status === 'dead');
    expect((await w.deliveries())[0]?.last_error).toContain('blocked_address');
    expect(w.mine()).toHaveLength(0);
  });

  it('finishes in-flight deliveries on graceful stop', async () => {
    const w = await world();
    reply(200, 500);
    const worker = await startWorker();
    await w.send('slow receiver');
    await w.waitFor(() => w.mine().length === 1);
    await worker.stop();
    expect((await w.deliveries())[0]?.status).toBe('succeeded');
  });

  it('prunes old succeeded deliveries and outbox rows', async () => {
    const w = await world();
    reply(200);
    const worker = await startWorker({ EVENT_RETENTION_MS: '604800000' });
    await w.send('old news');
    await w.waitFor(async () => (await w.deliveries())[0]?.status === 'succeeded');
    const eight = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const [delivery] = await w.deliveries();
    await sql`update event_outbox set created_at = ${eight} where id = ${delivery!.event_id}`.execute(
      infra.db,
    );
    await infra.db
      .updateTable('event_deliveries')
      .set({ delivered_at: eight })
      .where('id', '=', delivery!.id)
      .execute();
    await w.send('fresh news');
    await w.waitFor(async () => (await w.deliveries()).length === 2);

    await worker.prune();
    const remaining = await w.deliveries();
    expect(remaining.map((d) => d.event_id)).not.toContain(delivery!.event_id);
    expect(remaining).toHaveLength(1);
    const outbox = await infra.db
      .selectFrom('event_outbox')
      .select('id')
      .where('id', '=', delivery!.event_id)
      .execute();
    expect(outbox).toHaveLength(0);
  });
});
