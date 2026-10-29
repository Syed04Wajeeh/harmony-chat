import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { InteractionPayload, Panel, Schedule } from '@harmony/shared';
import { verifySignature } from '@harmony/shared/signature';
import { Scheduler, type RefreshJob } from '../../src/schedules/scheduler.js';
import {
  TestSocket,
  api,
  createChannel,
  createGuild,
  createInfra,
  ensureUser,
  type Infra,
  type TestApp,
} from './support/harness.js';
import { Receiver, addBotToGuild, botApi, createBot } from './support/bots.js';

const uid = () => randomUUID().slice(0, 8);
const silent = { warn: () => undefined };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stat = (value: number) => ({
  title: 'Host',
  blocks: [{ type: 'stat', label: 'CPU', value }],
});

describe('bot schedules', () => {
  let infra: Infra;
  /** No scheduler loop: REST behaviour and manual ticks. */
  let quiet: TestApp;
  /** Two instances that both run the scheduler, with the shortest interval allowed. */
  let a: TestApp;
  let b: TestApp;
  const receivers: Receiver[] = [];
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    infra = createInfra();
    const env = {
      PANEL_COALESCE_MS: '0',
      PANEL_RATE_MAX: '1000',
      MESSAGE_RATE_MAX: '1000',
      OUTBOUND_PRIVATE_ALLOWLIST: '127.0.0.1',
    };
    quiet = await infra.startApp(env);
    const ticking = {
      ...env,
      SCHEDULER_TICK_MS: '100',
      SCHEDULE_MIN_EVERY_SECONDS: '1',
      INTERACTION_DEADLINE_MS: '1500',
    };
    [a, b] = await Promise.all([infra.startApp(ticking), infra.startApp(ticking)]);
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((socket) => socket.close()));
    await Promise.all(receivers.splice(0).map((receiver) => receiver.stop()));
  });
  afterAll(async () => {
    await infra.stop();
  });

  async function world(botBody: Record<string, unknown> = {}) {
    const owner = `owner-${uid()}@example.com`;
    const alice = `alice-${uid()}@example.com`;
    const manager = `manager-${uid()}@example.com`;
    await ensureUser(infra.db, owner, { admin: true });
    const guildId = await createGuild(infra.db, owner, [alice, manager]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const role = await api(quiet, owner)(`/api/guilds/${guildId}/roles`, {
      method: 'POST',
      body: { name: 'Managers', permissions: ['manage_channels'] },
    });
    const managerId = await ensureUser(infra.db, manager);
    await api(quiet, owner)(
      `/api/guilds/${guildId}/members/${managerId}/roles/${(role.body as { id: string }).id}`,
      { method: 'PUT' },
    );
    const created = await createBot(quiet, owner, {
      scopes: ['messages.read', 'messages.write', 'channels.read', 'commands', 'panels.write'],
      ...botBody,
    });
    await addBotToGuild(quiet, owner, guildId, created.bot.id);
    const botOn = (on: TestApp) => botApi(on, created.token);
    const put = (schedules: unknown[], on: TestApp = quiet) =>
      botOn(on)('/api/bots/@me/schedules', { method: 'PUT', body: { schedules } });
    const rows = () =>
      infra.db
        .selectFrom('bot_schedules')
        .selectAll()
        .where('bot_id', '=', created.bot.id)
        .execute();
    const makeDue = () =>
      sql`update bot_schedules set next_run_at = now() where bot_id = ${created.bot.id} and not paused`.execute(
        infra.db,
      );
    return { owner, alice, manager, guildId, channelId, ...created, botOn, put, rows, makeDue };
  }

  async function receiverFor(
    answer: (payload: InteractionPayload) => unknown = () => ({ type: 'deferred' }),
  ) {
    const receiver = await Receiver.start();
    receivers.push(receiver);
    receiver.handler = (request) => ({
      body: answer(JSON.parse(request.body) as InteractionPayload),
    });
    return receiver;
  }

  async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition');
      await sleep(20);
    }
  }

  describe('registering', () => {
    it('stores entries for a bot token, with cron or interval', async () => {
      const w = await world();
      const res = await w.put([
        { id: 'dash', channelId: w.channelId, every: 60, panelKey: 'host' },
        { id: 'nightly', channelId: w.channelId, cron: '0 3 * * *' },
      ]);
      expect(res.status).toBe(200);
      const schedules = (res.body as { schedules: Schedule[] }).schedules;
      expect(schedules.map((s) => s.id)).toEqual(['dash', 'nightly']);
      expect(schedules[0]).toMatchObject({
        every: 60,
        cron: null,
        panelKey: 'host',
        paused: false,
        guildId: w.guildId,
        botId: w.bot.id,
      });
      expect(schedules[1]).toMatchObject({ every: null, cron: '0 3 * * *', panelKey: null });
      // Interval: a minute away (plus jitter); cron: the next 03:00 UTC.
      const inMs = new Date(schedules[0]?.nextRunAt ?? '').getTime() - Date.now();
      expect(inMs).toBeGreaterThan(55_000);
      expect(inMs).toBeLessThan(72_000);
      expect(new Date(schedules[1]?.nextRunAt ?? '').getUTCHours()).toBe(3);

      const read = await w.botOn(quiet)('/api/bots/@me/schedules');
      expect((read.body as { schedules: Schedule[] }).schedules).toHaveLength(2);
    });

    it('is a bulk overwrite: entries left out are removed', async () => {
      const w = await world();
      await w.put([
        { id: 'one', channelId: w.channelId, every: 60 },
        { id: 'two', channelId: w.channelId, every: 120 },
      ]);
      await w.put([{ id: 'two', channelId: w.channelId, every: 120 }]);
      expect((await w.rows()).map((row) => row.slug)).toEqual(['two']);
      await w.put([]);
      expect(await w.rows()).toEqual([]);
    });

    it('keeps next run and the pause when a bot registers the same schedule again', async () => {
      const w = await world();
      const first = await w.put([{ id: 'dash', channelId: w.channelId, every: 600 }]);
      const before = (first.body as { schedules: Schedule[] }).schedules[0] as Schedule;
      const asManager = api(quiet, w.manager);
      const paused = await asManager(`/api/schedules/${before.rowId}`, {
        method: 'PATCH',
        body: { paused: true },
      });
      expect(paused.status).toBe(200);

      const second = await w.put([{ id: 'dash', channelId: w.channelId, every: 600 }]);
      const after = (second.body as { schedules: Schedule[] }).schedules[0] as Schedule;
      expect(after).toMatchObject({
        rowId: before.rowId,
        paused: true,
        nextRunAt: before.nextRunAt,
      });

      // A changed cadence recomputes the next run but still respects the pause.
      const third = await w.put([{ id: 'dash', channelId: w.channelId, every: 900 }]);
      const changed = (third.body as { schedules: Schedule[] }).schedules[0] as Schedule;
      expect(changed.paused).toBe(true);
      expect(changed.nextRunAt).not.toBe(before.nextRunAt);
    });

    it('validates entries and limits', async () => {
      const w = await world();
      const ok = { id: 'x', channelId: w.channelId };
      const code = async (schedules: unknown[]) => {
        const res = await w.put(schedules);
        return [res.status, (res.body as { code?: string }).code] as const;
      };
      expect((await code([{ ...ok, every: 59 }]))[1]).toBe('schedule_too_frequent');
      expect((await code([{ ...ok, every: 86_401 }]))[0]).toBe(400);
      expect((await code([{ ...ok }]))[0]).toBe(400);
      expect((await code([{ ...ok, every: 60, cron: '* * * * *' }]))[0]).toBe(400);
      expect((await code([{ ...ok, cron: '99 * * * *' }]))[0]).toBe(400);
      expect(
        await code([
          { ...ok, every: 60 },
          { ...ok, every: 60 },
        ]),
      ).toEqual([400, 'duplicate_schedule']);
      expect(
        await code(
          Array.from({ length: 21 }, (_, i) => ({
            id: `s${String(i)}`,
            channelId: w.channelId,
            every: 60,
          })),
        ),
      ).toEqual([409, 'schedule_limit']);
      const twenty = Array.from({ length: 20 }, (_, i) => ({
        id: `s${String(i)}`,
        channelId: w.channelId,
        every: 60,
      }));
      expect((await w.put(twenty)).status).toBe(200);
    });

    it('refuses channels the bot cannot see, other guilds’ channels and DMs', async () => {
      const w = await world();
      const other = await createChannel(infra.db, [w.owner]);
      const res = await w.put([{ id: 'x', channelId: other, every: 60 }]);
      expect(res.status).toBe(409);
      expect((res.body as { code: string }).code).toBe('bot_not_in_channel');
      const unknown = await w.put([{ id: 'x', channelId: '999999999', every: 60 }]);
      expect(unknown.status).toBe(409);
    });

    it('needs the commands scope and a bot token', async () => {
      const w = await world();
      const plain = await createBot(quiet, w.owner, { scopes: ['messages.write'] });
      const denied = await botApi(quiet, plain.token)('/api/bots/@me/schedules', {
        method: 'PUT',
        body: { schedules: [] },
      });
      expect(denied.status).toBe(403);
      expect((denied.body as { code: string }).code).toBe('missing_scope');
      const human = await api(quiet, w.owner)('/api/bots/@me/schedules', {
        method: 'PUT',
        body: { schedules: [] },
      });
      expect(human.status).toBe(403);
    });
  });

  describe('managing', () => {
    it('lists a channel’s schedules for managers only, and lets them pause and delete', async () => {
      const w = await world();
      const res = await w.put([{ id: 'dash', channelId: w.channelId, every: 600 }]);
      const row = (res.body as { schedules: Schedule[] }).schedules[0] as Schedule;

      expect((await api(quiet, w.alice)(`/api/channels/${w.channelId}/schedules`)).status).toBe(
        403,
      );
      const listed = await api(quiet, w.manager)(`/api/channels/${w.channelId}/schedules`);
      expect(listed.status).toBe(200);
      expect((listed.body as { schedules: Schedule[] }).schedules).toHaveLength(1);

      const denied = await api(quiet, w.alice)(`/api/schedules/${row.rowId}`, {
        method: 'PATCH',
        body: { paused: true },
      });
      expect(denied.status).toBe(403);
      expect(
        (await api(quiet, w.alice)(`/api/schedules/${row.rowId}`, { method: 'DELETE' })).status,
      ).toBe(403);

      const paused = await api(quiet, w.manager)(`/api/schedules/${row.rowId}`, {
        method: 'PATCH',
        body: { paused: true },
      });
      expect((paused.body as Schedule).paused).toBe(true);
      const resumed = await api(quiet, w.manager)(`/api/schedules/${row.rowId}`, {
        method: 'PATCH',
        body: { paused: false },
      });
      expect((resumed.body as Schedule).paused).toBe(false);

      const removed = await api(quiet, w.manager)(`/api/schedules/${row.rowId}`, {
        method: 'DELETE',
      });
      expect(removed.status).toBe(204);
      expect(await w.rows()).toEqual([]);
      expect(
        (await api(quiet, w.manager)(`/api/schedules/${row.rowId}`, { method: 'DELETE' })).status,
      ).toBe(404);
    });

    it('stops a bot’s schedules when it is removed from the guild', async () => {
      const w = await world();
      await w.put([{ id: 'dash', channelId: w.channelId, every: 600 }]);
      expect(await w.rows()).toHaveLength(1);
      const removed = await api(quiet, w.owner)(`/api/guilds/${w.guildId}/bots/${w.bot.id}`, {
        method: 'DELETE',
      });
      expect(removed.status).toBe(204);
      expect(await w.rows()).toEqual([]);
    });
  });

  describe('claiming', () => {
    const scheduler = (
      refresh: (job: RefreshJob) => Promise<{ ok: true } | { ok: false; error: string }>,
    ) => new Scheduler(infra.db, refresh, { tickMs: 0, pendingMs: 60_000 }, silent, () => 0);

    it('runs a due schedule once even when two schedulers tick at the same moment', async () => {
      const w = await world();
      await w.put(
        Array.from({ length: 8 }, (_, i) => ({
          id: `s${String(i)}`,
          channelId: w.channelId,
          every: 600,
        })),
      );
      await w.makeDue();
      const seen: string[] = [];
      const run = async (job: RefreshJob) => {
        seen.push(job.slug);
        await sleep(30);
        return { ok: true as const };
      };
      const [one, two] = await Promise.all([scheduler(run).tick(), scheduler(run).tick()]);
      expect(one + two).toBe(8);
      expect([...seen].sort()).toEqual(Array.from({ length: 8 }, (_, i) => `s${String(i)}`));
      const rows = await w.rows();
      expect(rows.every((row) => row.last_status === 'ok' && row.pending_until === null)).toBe(
        true,
      );
      expect(rows.every((row) => row.next_run_at.getTime() > Date.now() + 500_000)).toBe(true);
      // Nothing is due any more.
      expect(await scheduler(run).tick()).toBe(0);
    });

    it('skips a schedule while its previous run is still pending, then picks it up again', async () => {
      const w = await world();
      await w.put([{ id: 'slow', channelId: w.channelId, every: 600 }]);
      await w.makeDue();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      const slow = scheduler(async () => {
        calls += 1;
        await gate;
        return { ok: true };
      });
      const first = slow.tick();
      await waitUntil(async () => (await w.rows())[0]?.pending_until != null);

      await w.makeDue();
      expect(await scheduler(() => Promise.reject(new Error('must not run'))).tick()).toBe(0);
      const skipped = (await w.rows())[0];
      expect(skipped).toMatchObject({ last_status: 'skipped' });
      expect(skipped?.next_run_at.getTime()).toBeGreaterThan(Date.now() + 500_000);

      release();
      await first;
      expect(calls).toBe(1);
      expect((await w.rows())[0]).toMatchObject({ last_status: 'ok', pending_until: null });

      await w.makeDue();
      expect(await scheduler(() => Promise.resolve({ ok: true })).tick()).toBe(1);
    });

    it('frees a schedule whose pending marker expired (a crashed instance)', async () => {
      const w = await world();
      await w.put([{ id: 'stuck', channelId: w.channelId, every: 600 }]);
      await sql`
        update bot_schedules set next_run_at = now(), pending_until = now() - interval '1 second'
        where bot_id = ${w.bot.id}
      `.execute(infra.db);
      expect(await scheduler(() => Promise.resolve({ ok: true })).tick()).toBe(1);
    });

    it('records a failure and keeps the schedule going', async () => {
      const w = await world();
      await w.put([{ id: 'bad', channelId: w.channelId, every: 600 }]);
      await w.makeDue();
      await scheduler(() => Promise.resolve({ ok: false, error: 'timeout' })).tick();
      const row = (await w.rows())[0];
      expect(row).toMatchObject({ last_status: 'failed', last_error: 'timeout', paused: false });
      expect(row?.last_run_at).not.toBeNull();
      // A thrown error is a failure too, not a crash.
      await w.makeDue();
      await scheduler(() => Promise.reject(new Error('boom'))).tick();
      expect((await w.rows())[0]).toMatchObject({ last_status: 'failed', last_error: 'error' });
    });

    it('does not run paused schedules', async () => {
      const w = await world();
      const res = await w.put([{ id: 'idle', channelId: w.channelId, every: 600 }]);
      const row = (res.body as { schedules: Schedule[] }).schedules[0] as Schedule;
      await api(quiet, w.manager)(`/api/schedules/${row.rowId}`, {
        method: 'PATCH',
        body: { paused: true },
      });
      await sql`update bot_schedules set next_run_at = now() - interval '1 hour' where bot_id = ${w.bot.id}`.execute(
        infra.db,
      );
      expect(await scheduler(() => Promise.resolve({ ok: true })).tick()).toBe(0);
    });
  });

  describe('delivery', () => {
    it('sends a signed refresh to the interactions URL, once, across two running instances', async () => {
      const receiver = await receiverFor();
      const w = await world({ interactionsUrl: `${receiver.url}/interactions` });
      await w.put([{ id: 'dash', channelId: w.channelId, every: 3600, panelKey: 'host' }], a);
      await w.makeDue();
      await receiver.waitFor(1);
      // Both instances are polling every 100 ms; give a second claim every chance to happen.
      await sleep(800);
      expect(receiver.requests).toHaveLength(1);

      const request = receiver.requests[0];
      expect(
        verifySignature({
          secret: w.signingSecret,
          timestamp: request?.headers['x-harmony-timestamp'] as string,
          signature: request?.headers['x-harmony-signature'] as string,
          body: request?.body ?? '',
        }),
      ).toBe(true);
      const payload = JSON.parse(request?.body ?? '{}') as InteractionPayload;
      expect(payload).toMatchObject({
        type: 'refresh',
        guildId: w.guildId,
        channelId: w.channelId,
        schedule: { id: 'dash', channelId: w.channelId, panelKey: 'host' },
      });
      expect(payload).not.toHaveProperty('user');
      await waitUntil(async () => (await w.rows())[0]?.last_status === 'ok');
    });

    it('applies an update_panel answer to the named panel', async () => {
      const receiver = await receiverFor(() => ({ type: 'update_panel', view: stat(42) }));
      const w = await world({ interactionsUrl: `${receiver.url}/i` });
      const made = await w.botOn(quiet)(`/api/channels/${w.channelId}/panels/host`, {
        method: 'PUT',
        body: { view: stat(1), pinned: true },
      });
      expect(made.status).toBe(200);
      await w.put([{ id: 'dash', channelId: w.channelId, every: 3600, panelKey: 'host' }], b);
      await w.makeDue();
      await waitUntil(async () => (await w.rows())[0]?.last_status === 'ok');
      const listed = await api(quiet, w.alice)(`/api/channels/${w.channelId}/panels`);
      const panel = (listed.body as { panels: Panel[] }).panels[0];
      expect(panel?.view.blocks[0]).toMatchObject({ value: 42 });
      expect(panel?.version).toBe(2);
    });

    it('posts a message answer as the bot', async () => {
      const receiver = await receiverFor(() => ({ type: 'message', content: 'daily summary' }));
      const w = await world({ interactionsUrl: `${receiver.url}/i` });
      await w.put([{ id: 'daily', channelId: w.channelId, every: 3600 }], a);
      await w.makeDue();
      await waitUntil(async () => (await w.rows())[0]?.last_status === 'ok');
      const history = await api(quiet, w.alice)(`/api/channels/${w.channelId}/messages`);
      expect(JSON.stringify(history.body)).toContain('daily summary');
    });

    it('records bad answers and unreachable bots as failures', async () => {
      // update_panel for a schedule without a panelKey cannot be applied.
      const receiver = await receiverFor(() => ({ type: 'update_panel', view: stat(1) }));
      const w = await world({ interactionsUrl: `${receiver.url}/i` });
      await w.put([{ id: 'nopanel', channelId: w.channelId, every: 3600 }], a);
      await w.makeDue();
      await waitUntil(async () => (await w.rows())[0]?.last_status === 'failed');
      expect((await w.rows())[0]?.last_error).toBe('invalid_response');

      receiver.handler = () => ({ status: 500 });
      await w.makeDue();
      await waitUntil(async () => (await w.rows())[0]?.last_error === 'bad_status');

      await receiver.stop();
      receivers.splice(receivers.indexOf(receiver), 1);
      await w.makeDue();
      await waitUntil(async () => (await w.rows())[0]?.last_error === 'unreachable');
    });

    it('does not deliver after a manager pauses the schedule', async () => {
      const receiver = await receiverFor();
      const w = await world({ interactionsUrl: `${receiver.url}/i` });
      const res = await w.put([{ id: 'dash', channelId: w.channelId, every: 3600 }], a);
      const row = (res.body as { schedules: Schedule[] }).schedules[0] as Schedule;
      await api(a, w.manager)(`/api/schedules/${row.rowId}`, {
        method: 'PATCH',
        body: { paused: true },
      });
      await sql`update bot_schedules set next_run_at = now() where bot_id = ${w.bot.id}`.execute(
        infra.db,
      );
      await sleep(700);
      expect(receiver.requests).toHaveLength(0);
    });

    it('delivers a refresh over the gateway to a bot without an interactions URL, whichever instance holds the socket', async () => {
      const w = await world();
      expect(w.bot.delivery.interactions).toBe('gateway');
      await w.put([{ id: 'dash', channelId: w.channelId, every: 3600, panelKey: 'host' }], a);
      const made = await w.botOn(a)(`/api/channels/${w.channelId}/panels/host`, {
        method: 'PUT',
        body: { view: stat(1) },
      });
      expect(made.status).toBe(200);

      const socket = await TestSocket.connectWith(b, { authorization: `Bot ${w.token}` });
      sockets.push(socket);
      await socket.waitFor('hello');
      await w.makeDue();
      await waitUntil(() => socket.of('interaction.create').length > 0);
      await sleep(600);
      expect(socket.of('interaction.create')).toHaveLength(1);
      const payload = socket.of('interaction.create')[0]?.interaction as InteractionPayload;
      expect(payload).toMatchObject({
        type: 'refresh',
        schedule: { id: 'dash', panelKey: 'host' },
      });

      socket.send({
        type: 'interaction.respond',
        interactionId: payload.id,
        token: payload.token,
        response: { type: 'update_panel', view: stat(7) },
      });
      await waitUntil(async () => (await w.rows())[0]?.last_status === 'ok');
      const listed = await api(a, w.alice)(`/api/channels/${w.channelId}/panels`);
      expect((listed.body as { panels: Panel[] }).panels[0]?.view.blocks[0]).toMatchObject({
        value: 7,
      });
    });

    it('records unreachable when a gateway bot is offline', async () => {
      const w = await world();
      await w.put([{ id: 'dash', channelId: w.channelId, every: 3600 }], b);
      await w.makeDue();
      await waitUntil(async () => (await w.rows())[0]?.last_status === 'failed');
      expect((await w.rows())[0]?.last_error).toBe('unreachable');
    });
  });
});
