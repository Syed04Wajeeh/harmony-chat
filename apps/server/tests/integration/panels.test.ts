import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Panel } from '@harmony/shared';
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
import { addBotToGuild, botApi, createBot } from './support/bots.js';

const uid = () => randomUUID().slice(0, 8);

const stat = (value: number) => ({ type: 'stat', label: 'CPU', value, unit: '%' });
const view = (value = 1) => ({ title: 'Host', blocks: [stat(value)] });
const chartView = (count = 1) => ({
  blocks: [
    {
      type: 'chart',
      id: 'cpu',
      kind: 'line',
      series: [{ name: 'host', points: Array.from({ length: count }, (_, i) => ({ x: i, y: i })) }],
    },
  ],
});

describe('panels', () => {
  let infra: Infra;
  let target: TestApp;

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ PANEL_COALESCE_MS: '0', PANEL_RATE_MAX: '1000' });
  });
  afterAll(async () => {
    await infra.stop();
  });

  async function world() {
    const owner = `owner-${uid()}@example.com`;
    const alice = `alice-${uid()}@example.com`;
    const outsider = `outsider-${uid()}@example.com`;
    await ensureUser(infra.db, owner, { admin: true });
    await ensureUser(infra.db, outsider);
    const guildId = await createGuild(infra.db, owner, [alice]);
    const channelId = await createChannel(infra.db, [owner], {
      guildId,
      createdBy: owner,
      kind: 'dashboard',
    });
    const made = await createBot(target, owner, {
      scopes: ['messages.read', 'messages.write', 'channels.read', 'panels.write'],
    });
    await addBotToGuild(target, owner, guildId, made.bot.id);
    const bot = botApi(target, made.token);
    const put = (key: string, body: unknown, channel = channelId) =>
      bot(`/api/channels/${channel}/panels/${key}`, { method: 'PUT', body });
    return { owner, alice, outsider, guildId, channelId, bot, botId: made.bot.id, put, made };
  }

  it('creates a panel, then replaces it and bumps the version', async () => {
    const w = await world();
    const first = await w.put('host', { view: view(1) });
    expect(first.status).toBe(200);
    const created = first.body as Panel;
    expect(created).toMatchObject({ key: 'host', version: 1, pinned: false, botId: w.botId });

    const second = await w.put('host', { view: view(2), pinned: true });
    const updated = second.body as Panel;
    expect(updated.id).toBe(created.id);
    expect(updated.version).toBe(2);
    expect(updated.pinned).toBe(true);

    const listed = await api(target, w.alice)(`/api/channels/${w.channelId}/panels`);
    expect(listed.status).toBe(200);
    const panels = (listed.body as { panels: Panel[] }).panels;
    expect(panels).toHaveLength(1);
    expect(panels[0]?.view.blocks[0]).toMatchObject({ value: 2 });
  });

  it('keeps the same key separate per bot and per channel', async () => {
    const w = await world();
    const other = await createBot(target, w.owner, { scopes: ['panels.write'] });
    await addBotToGuild(target, w.owner, w.guildId, other.bot.id);
    await w.put('host', { view: view() });
    const second = await botApi(target, other.token)(`/api/channels/${w.channelId}/panels/host`, {
      method: 'PUT',
      body: { view: view() },
    });
    expect(second.status).toBe(200);
    const listed = await api(target, w.alice)(`/api/channels/${w.channelId}/panels`);
    expect((listed.body as { panels: Panel[] }).panels).toHaveLength(2);
  });

  it('rejects invalid views with 400', async () => {
    const w = await world();
    expect((await w.put('host', { view: { blocks: [] } })).status).toBe(400);
    expect(
      (await w.put('host', { view: { blocks: [{ type: 'html', html: '<b>' }] } })).status,
    ).toBe(400);
    expect((await w.put('Bad Key', { view: view() })).status).toBe(400);
  });

  it('allows 20 panels per channel and refuses the 21st, but still updates an existing one', async () => {
    const w = await world();
    for (let i = 0; i < 20; i++) {
      expect((await w.put(`p${String(i)}`, { view: view(i) })).status).toBe(200);
    }
    const over = await w.put('p20', { view: view() });
    expect(over.status).toBe(409);
    expect((over.body as { code: string }).code).toBe('panel_limit');
    expect((await w.put('p3', { view: view(99) })).status).toBe(200);
  });

  it('does not let people send messages into a dashboard channel', async () => {
    const w = await world();
    const res = await api(target, w.alice)(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      body: { content: 'hello?' },
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('dashboard_channel');
    const channels = await api(target, w.alice)('/api/channels');
    const kinds = (channels.body as { channels: { id: string; kind: string }[] }).channels;
    expect(kinds.find((c) => c.id === w.channelId)?.kind).toBe('dashboard');
  });

  it('works in a normal text channel too, where pinned panels sit above the messages', async () => {
    const w = await world();
    const text = await createChannel(infra.db, [w.owner], { guildId: w.guildId });
    const res = await w.put('status', { view: view(), pinned: true }, text);
    expect(res.status).toBe(200);
    expect((res.body as Panel).pinned).toBe(true);
  });

  describe('points', () => {
    it('appends to a series and creates new ones', async () => {
      const w = await world();
      await w.put('host', { view: chartView(1) });
      const res = await w.bot(`/api/channels/${w.channelId}/panels/host/points`, {
        method: 'POST',
        body: {
          blockId: 'cpu',
          series: 'host',
          points: [
            { x: 10, y: 1 },
            { x: 11, y: 2 },
          ],
        },
      });
      expect(res.status).toBe(200);
      const panel = res.body as Panel;
      expect(panel.version).toBe(2);
      const block = panel.view.blocks[0];
      expect(block?.type === 'chart' && block.series[0]?.points).toHaveLength(3);

      const other = await w.bot(`/api/channels/${w.channelId}/panels/host/points`, {
        method: 'POST',
        body: { blockId: 'cpu', series: 'gpu', points: [{ x: 1, y: 1 }] },
      });
      const next = (other.body as Panel).view.blocks[0];
      expect(next?.type === 'chart' && next.series.map((s) => s.name)).toEqual(['host', 'gpu']);
    });

    it('trims a series to its newest 500 points', async () => {
      const w = await world();
      await w.put('host', { view: chartView(495) });
      const res = await w.bot(`/api/channels/${w.channelId}/panels/host/points`, {
        method: 'POST',
        body: {
          blockId: 'cpu',
          series: 'host',
          points: Array.from({ length: 20 }, (_, i) => ({ x: 1000 + i, y: i })),
        },
      });
      expect(res.status).toBe(200);
      const block = (res.body as Panel).view.blocks[0];
      const points = block?.type === 'chart' ? (block.series[0]?.points ?? []) : [];
      expect(points).toHaveLength(500);
      expect(points[499]).toEqual({ x: 1019, y: 19 });
      expect(points[0]).toEqual({ x: 15, y: 15 });
    });

    it('does not lose points when appends arrive at the same time', async () => {
      const w = await world();
      await w.put('host', { view: chartView(0) });
      const append = (n: number) =>
        w.bot(`/api/channels/${w.channelId}/panels/host/points`, {
          method: 'POST',
          body: { blockId: 'cpu', series: 'host', points: [{ x: n, y: n }] },
        });
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => append(i)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      const listed = await api(target, w.alice)(`/api/channels/${w.channelId}/panels`);
      const panel = (listed.body as { panels: Panel[] }).panels[0];
      const block = panel?.view.blocks[0];
      expect(block?.type === 'chart' && block.series[0]?.points).toHaveLength(8);
      expect(panel?.version).toBe(9);
    });

    it('refuses a block that is not a chart, and a panel that does not exist', async () => {
      const w = await world();
      await w.put('host', { view: { blocks: [{ ...stat(1), id: 'cpu' }] } });
      const wrongBlock = await w.bot(`/api/channels/${w.channelId}/panels/host/points`, {
        method: 'POST',
        body: { blockId: 'cpu', series: 'a', points: [{ x: 1, y: 1 }] },
      });
      expect(wrongBlock.status).toBe(400);
      const missing = await w.bot(`/api/channels/${w.channelId}/panels/nope/points`, {
        method: 'POST',
        body: { blockId: 'cpu', series: 'a', points: [{ x: 1, y: 1 }] },
      });
      expect(missing.status).toBe(404);
    });
  });

  describe('who may do what', () => {
    it('needs the panels.write scope', async () => {
      const w = await world();
      const bare = await createBot(target, w.owner, { scopes: ['messages.write'] });
      await addBotToGuild(target, w.owner, w.guildId, bare.bot.id);
      const res = await botApi(target, bare.token)(`/api/channels/${w.channelId}/panels/x`, {
        method: 'PUT',
        body: { view: view() },
      });
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe('missing_scope');
    });

    it('needs the bot to be in the guild', async () => {
      const w = await world();
      const stranger = await createBot(target, w.owner, { scopes: ['panels.write'] });
      const res = await botApi(target, stranger.token)(`/api/channels/${w.channelId}/panels/x`, {
        method: 'PUT',
        body: { view: view() },
      });
      expect(res.status).toBe(403);
    });

    it('is not open to people through the bot routes', async () => {
      const w = await world();
      const res = await api(target, w.owner)(`/api/channels/${w.channelId}/panels/x`, {
        method: 'PUT',
        body: { view: view() },
      });
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe('bots_only');
    });

    it('hides panels from people who cannot view the channel', async () => {
      const w = await world();
      await w.put('host', { view: view() });
      const outsider = await api(target, w.outsider)(`/api/channels/${w.channelId}/panels`);
      expect(outsider.status).toBe(403);
      const privateChannel = await createChannel(infra.db, [w.owner], {
        guildId: w.guildId,
        createdBy: w.owner,
        private: true,
        kind: 'dashboard',
      });
      const denied = await api(target, w.alice)(`/api/channels/${privateChannel}/panels`);
      expect(denied.status).toBe(403);
    });

    it('lets only people with manage_channels pin and delete, and the bot delete its own', async () => {
      const w = await world();
      const created = (await w.put('host', { view: view() })).body as Panel;

      const pinDenied = await api(target, w.alice)(`/api/panels/${created.id}`, {
        method: 'PATCH',
        body: { pinned: true },
      });
      expect(pinDenied.status).toBe(403);
      const deleteDenied = await api(target, w.alice)(`/api/panels/${created.id}`, {
        method: 'DELETE',
      });
      expect(deleteDenied.status).toBe(403);

      const pinned = await api(target, w.owner)(`/api/panels/${created.id}`, {
        method: 'PATCH',
        body: { pinned: true },
      });
      expect(pinned.status).toBe(200);
      expect((pinned.body as Panel).pinned).toBe(true);
      expect((pinned.body as Panel).version).toBe(2);
      expect(
        (await api(target, w.owner)(`/api/panels/${created.id}`, { method: 'DELETE' })).status,
      ).toBe(204);

      await w.put('again', { view: view() });
      expect(
        (await w.bot(`/api/channels/${w.channelId}/panels/again`, { method: 'DELETE' })).status,
      ).toBe(204);
      expect(
        (await w.bot(`/api/channels/${w.channelId}/panels/again`, { method: 'DELETE' })).status,
      ).toBe(404);
    });

    it('stops a bot that cannot send messages in the channel', async () => {
      const w = await world();
      const denied = await api(target, w.owner)(
        `/api/channels/${w.channelId}/overwrites/member/${w.botId}`,
        { method: 'PUT', body: { allow: [], deny: ['send_messages'] } },
      );
      expect(denied.status).toBe(200);
      const res = await w.put('host', { view: view() });
      expect(res.status).toBe(403);
    });
  });

  it('answers 429 once a bot exceeds its write rate', async () => {
    const limited = await infra.startApp({ PANEL_RATE_MAX: '3', PANEL_RATE_WINDOW_SECONDS: '30' });
    const owner = `owner-${uid()}@example.com`;
    await ensureUser(infra.db, owner, { admin: true });
    const guildId = await createGuild(infra.db, owner);
    const channelId = await createChannel(infra.db, [owner], { guildId, kind: 'dashboard' });
    const made = await createBot(limited, owner, { scopes: ['panels.write'] });
    await addBotToGuild(limited, owner, guildId, made.bot.id);
    const bot = botApi(limited, made.token);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await bot(`/api/channels/${channelId}/panels/host`, {
        method: 'PUT',
        body: { view: view(i) },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });
});

describe('panel realtime', () => {
  let infra: Infra;
  const sockets: TestSocket[] = [];

  beforeAll(() => {
    infra = createInfra();
  });
  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  async function room(app: TestApp, other?: TestApp) {
    const owner = `owner-${uid()}@example.com`;
    const alice = `alice-${uid()}@example.com`;
    const bob = `bob-${uid()}@example.com`;
    await ensureUser(infra.db, owner, { admin: true });
    const guildId = await createGuild(infra.db, owner, [alice, bob]);
    const channelId = await createChannel(infra.db, [owner], {
      guildId,
      createdBy: owner,
      kind: 'dashboard',
    });
    const made = await createBot(app, owner, { scopes: ['panels.write'] });
    await addBotToGuild(app, owner, guildId, made.bot.id);
    const aliceSocket = await TestSocket.connect(other ?? app, alice);
    const bobSocket = await TestSocket.connect(app, bob);
    sockets.push(aliceSocket, bobSocket);
    await aliceSocket.subscribe(channelId);
    const bot = botApi(app, made.token);
    const put = (value: number, key = 'host') =>
      bot(`/api/channels/${channelId}/panels/${key}`, {
        method: 'PUT',
        body: { view: view(value) },
      });
    return { owner, channelId, aliceSocket, bobSocket, put, bot };
  }

  it('sends panel.updated to subscribers, and panel.deleted when it goes', async () => {
    const app = await infra.startApp({ PANEL_COALESCE_MS: '0', PANEL_RATE_MAX: '1000' });
    const r = await room(app);
    await r.put(1);
    const [frame] = await r.aliceSocket.waitFor('panel.updated');
    expect(frame?.panel).toMatchObject({ key: 'host', version: 1 });
    expect(frame?.channelId).toBe(r.channelId);
    await r.bot(`/api/channels/${r.channelId}/panels/host`, { method: 'DELETE' });
    const [gone] = await r.aliceSocket.waitFor('panel.deleted');
    expect(gone?.panelId).toBe(frame?.panel.id);
    // Bob never subscribed to the channel, so nothing reaches him.
    expect(r.bobSocket.of('panel.updated')).toHaveLength(0);
  });

  it('coalesces a burst into a leading and a trailing frame carrying the latest version', async () => {
    const app = await infra.startApp({ PANEL_COALESCE_MS: '400', PANEL_RATE_MAX: '1000' });
    const r = await room(app);
    for (let i = 1; i <= 20; i++) await r.put(i);
    await r.aliceSocket.waitFor('panel.updated', 2);
    await settle(900);
    const versions = r.aliceSocket.of('panel.updated').map((f) => f.panel.version);
    expect(versions[0]).toBeLessThan(20);
    expect(versions.at(-1)).toBe(20);
    expect(versions.length).toBeLessThanOrEqual(4);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    const stored = await infra.db
      .selectFrom('panels')
      .select('version')
      .where('channel_id', '=', r.channelId)
      .executeTakeFirstOrThrow();
    expect(stored.version).toBe(20);
  });

  it('delivers across two app instances through Redis', async () => {
    const [a, b] = await Promise.all([
      infra.startApp({ PANEL_COALESCE_MS: '0', PANEL_RATE_MAX: '1000' }),
      infra.startApp({ PANEL_COALESCE_MS: '0', PANEL_RATE_MAX: '1000' }),
    ]);
    const r = await room(a, b);
    await r.put(7);
    const [frame] = await r.aliceSocket.waitFor('panel.updated');
    expect(frame?.panel.version).toBe(1);
    expect(frame?.panel.view.blocks[0]).toMatchObject({ value: 7 });
  });
});
