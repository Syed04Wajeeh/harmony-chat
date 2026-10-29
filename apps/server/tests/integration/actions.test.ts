import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InteractionPayload, Message, Panel } from '@harmony/shared';
import { verifySignature } from '@harmony/shared/signature';
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
import { Receiver, addBotToGuild, botApi, createBot, type Reply } from './support/bots.js';

const uid = () => randomUUID().slice(0, 8);

type ActionPayload = Extract<InteractionPayload, { type: 'action' }>;

const buttons = [
  { id: 'restart', label: 'Restart', style: 'danger', confirm: { title: 'Restart the host?' } },
  { id: 'refresh', label: 'Refresh' },
  { id: 'purge', label: 'Purge', requiredPermission: 'manage_messages' },
];
const panelView = (value = 1) => ({
  title: 'Host',
  blocks: [
    { type: 'stat', label: 'CPU', value },
    { type: 'actions', buttons },
  ],
});

describe('buttons', () => {
  let infra: Infra;
  let target: TestApp;
  let receiver: Receiver;

  beforeAll(async () => {
    infra = createInfra();
    receiver = await Receiver.start();
    target = await infra.startApp({
      OUTBOUND_PRIVATE_ALLOWLIST: '127.0.0.1',
      INTERACTION_DEADLINE_MS: '600',
      PANEL_COALESCE_MS: '0',
      PANEL_RATE_MAX: '1000',
      ACTION_RATE_MAX: '1000',
    });
  });
  afterAll(async () => {
    await infra.stop();
    await receiver.stop();
  });

  const answer = (build: (payload: ActionPayload) => Reply) => {
    receiver.requests.length = 0;
    receiver.handler = (request) => build(JSON.parse(request.body) as ActionPayload);
  };

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
      scopes: ['messages.read', 'messages.write', 'panels.write', 'commands'],
      interactionsUrl: `${receiver.url}/interactions`,
    });
    await addBotToGuild(target, owner, guildId, made.bot.id);
    const bot = botApi(target, made.token);
    const published = await bot(`/api/channels/${channelId}/panels/host`, {
      method: 'PUT',
      body: { view: panelView() },
    });
    expect(published.status).toBe(200);
    const panel = published.body as Panel;
    const aliceSocket = await TestSocket.connect(target, alice);
    await aliceSocket.subscribe(channelId);
    const click = (login: string, body: unknown) =>
      api(target, login)('/api/interactions/actions', { method: 'POST', body });
    const clickPanel = (login: string, actionId: string, nonce?: string) =>
      click(login, { source: { panelId: panel.id }, actionId, ...(nonce && { nonce }) });
    return {
      owner,
      alice,
      outsider,
      guildId,
      channelId,
      bot,
      botId: made.bot.id,
      signingSecret: made.signingSecret,
      panel,
      aliceSocket,
      click,
      clickPanel,
    };
  }

  it('calls the bot with a signed action payload and relays an ephemeral answer', async () => {
    const w = await world();
    answer(() => ({ body: { type: 'message', content: 'restarting', ephemeral: true } }));
    const res = await w.clickPanel(w.alice, 'restart', 'n-1');
    expect(res.status).toBe(202);

    const [frame] = await w.aliceSocket.waitFor('interaction.ephemeral');
    expect(frame).toMatchObject({
      content: 'restarting',
      kind: 'action',
      command: 'Restart',
      botId: w.botId,
      nonce: 'n-1',
    });

    const request = receiver.requests[0];
    expect(
      verifySignature({
        secret: w.signingSecret,
        timestamp: request?.headers['x-harmony-timestamp'] as string,
        signature: request?.headers['x-harmony-signature'] as string,
        body: request?.body ?? '',
      }),
    ).toBe(true);
    const payload = JSON.parse(request?.body ?? '{}') as ActionPayload;
    expect(payload).toMatchObject({
      type: 'action',
      guildId: w.guildId,
      channelId: w.channelId,
      action: { id: 'restart', source: { kind: 'panel', panelId: w.panel.id, key: 'host' } },
      user: { login: w.alice },
    });
    expect(payload.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await infra.db
      .selectFrom('interactions')
      .select(['type', 'action_id', 'panel_id', 'message_id'])
      .where('id', '=', payload.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      type: 'action',
      action_id: 'restart',
      panel_id: w.panel.id,
      message_id: null,
    });
  });

  it('replaces the panel when the bot answers update_panel', async () => {
    const w = await world();
    answer(() => ({ body: { type: 'update_panel', view: panelView(77) } }));
    await w.clickPanel(w.alice, 'refresh', 'n-up');
    const frames = await w.aliceSocket.waitFor('panel.updated', 1);
    const updated = frames.at(-1)?.panel;
    expect(updated?.version).toBe(2);
    expect(updated?.view.blocks[0]).toMatchObject({ value: 77 });
    const [done] = await w.aliceSocket.waitFor('interaction.completed');
    expect(done?.nonce).toBe('n-up');
  });

  it('rejects update_panel for a click that did not come from a panel', async () => {
    const w = await world();
    const sent = await w.bot(`/api/channels/${w.channelId}/messages`, { method: 'POST', body: {} });
    expect(sent.status).toBe(400);
    const text = await createChannel(infra.db, [w.owner], { guildId: w.guildId });
    const posted = await w.bot(`/api/channels/${text}/messages`, {
      method: 'POST',
      body: { content: 'Deploy?', components: { buttons: [{ id: 'go', label: 'Go' }] } },
    });
    expect(posted.status).toBe(201);
    const message = posted.body as Message;
    expect(message.components?.buttons[0]).toMatchObject({ id: 'go' });

    answer(() => ({ body: { type: 'update_panel', view: panelView() } }));
    const socket = await TestSocket.connect(target, w.alice);
    await socket.subscribe(text);
    const res = await w.click(w.alice, { source: { messageId: message.id }, actionId: 'go' });
    expect(res.status).toBe(202);
    const [failed] = await w.aliceSocket.waitFor('interaction.failed');
    expect(failed).toMatchObject({ reason: 'invalid_response', kind: 'action' });
    await socket.close();
  });

  it('handles buttons under bot messages, posting a public answer as the bot', async () => {
    const w = await world();
    const text = await createChannel(infra.db, [w.owner], { guildId: w.guildId });
    const posted = (
      await w.bot(`/api/channels/${text}/messages`, {
        method: 'POST',
        body: { content: 'Deploy?', components: { buttons: [{ id: 'go', label: 'Go' }] } },
      })
    ).body as Message;
    const socket = await TestSocket.connect(target, w.alice);
    await socket.subscribe(text);
    answer(() => ({ body: { type: 'message', content: 'deploying' } }));
    await w.click(w.alice, { source: { messageId: posted.id }, actionId: 'go', nonce: 'n-m' });
    const [created] = await socket.waitFor('message.created');
    expect(created?.message).toMatchObject({ content: 'deploying', author: { id: w.botId } });
    const [done] = await w.aliceSocket.waitFor('interaction.completed');
    expect(done?.nonce).toBe('n-m');
    const payload = JSON.parse(receiver.requests[0]?.body ?? '{}') as ActionPayload;
    expect(payload.action.source).toEqual({ kind: 'message', messageId: posted.id });
    await socket.close();
  });

  it('keeps buttons off messages from people and on history reads for bots', async () => {
    const w = await world();
    const text = await createChannel(infra.db, [w.owner], { guildId: w.guildId });
    const human = await api(target, w.alice)(`/api/channels/${text}/messages`, {
      method: 'POST',
      body: { content: 'hi', components: { buttons: [{ id: 'go', label: 'Go' }] } },
    });
    expect(human.status).toBe(400);
    const socket = await TestSocket.connect(target, w.alice);
    socket.send({
      type: 'message.send',
      channelId: text,
      content: 'hi',
      nonce: 'x',
      components: { buttons: [{ id: 'go', label: 'Go' }] },
    });
    const [ack] = await socket.waitFor('ack');
    expect(ack?.message.components).toBeUndefined();
    await w.bot(`/api/channels/${text}/messages`, {
      method: 'POST',
      body: { content: 'with buttons', components: { buttons: [{ id: 'go', label: 'Go' }] } },
    });
    const history = await api(target, w.alice)(`/api/channels/${text}/messages`);
    const withButtons = (history.body as { messages: Message[] }).messages.find(
      (m) => m.content === 'with buttons',
    );
    expect(withButtons?.components?.buttons).toHaveLength(1);
    await socket.close();
  });

  it('checks the click: membership, existing button, required permission', async () => {
    const w = await world();
    answer(() => ({ body: { type: 'message', content: 'ok', ephemeral: true } }));

    const outsider = await w.clickPanel(w.outsider, 'refresh');
    expect(outsider.status).toBe(403);

    const unknown = await w.clickPanel(w.alice, 'nope');
    expect(unknown.status).toBe(404);
    expect((unknown.body as { code: string }).code).toBe('unknown_action');

    const gone = await w.click(w.alice, { source: { panelId: '999999999' }, actionId: 'refresh' });
    expect(gone.status).toBe(404);

    const denied = await w.clickPanel(w.alice, 'purge');
    expect(denied.status).toBe(403);
    expect(receiver.requests).toHaveLength(0);

    const allowed = await w.clickPanel(w.owner, 'purge');
    expect(allowed.status).toBe(202);
  });

  it('refuses a button that the current version of the panel no longer has', async () => {
    const w = await world();
    await w.bot(`/api/channels/${w.channelId}/panels/host`, {
      method: 'PUT',
      body: { view: { blocks: [{ type: 'stat', label: 'CPU', value: 1 }] } },
    });
    const res = await w.clickPanel(w.alice, 'refresh');
    expect(res.status).toBe(404);
  });

  it('is human-only and rate limited', async () => {
    const w = await world();
    const asBot = await w.bot('/api/interactions/actions', {
      method: 'POST',
      body: { source: { panelId: w.panel.id }, actionId: 'refresh' },
    });
    expect(asBot.status).toBe(403);

    const limited = await infra.startApp({
      OUTBOUND_PRIVATE_ALLOWLIST: '127.0.0.1',
      ACTION_RATE_MAX: '2',
      ACTION_RATE_WINDOW_SECONDS: '30',
    });
    const owner = `owner-${uid()}@example.com`;
    await ensureUser(infra.db, owner, { admin: true });
    const guildId = await createGuild(infra.db, owner);
    const channelId = await createChannel(infra.db, [owner], { guildId, kind: 'dashboard' });
    const made = await createBot(limited, owner, {
      scopes: ['panels.write', 'commands'],
      interactionsUrl: `${receiver.url}/interactions`,
    });
    await addBotToGuild(limited, owner, guildId, made.bot.id);
    const panel = (
      await botApi(limited, made.token)(`/api/channels/${channelId}/panels/host`, {
        method: 'PUT',
        body: { view: panelView() },
      })
    ).body as Panel;
    answer(() => ({ body: { type: 'deferred' } }));
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await api(limited, owner)('/api/interactions/actions', {
        method: 'POST',
        body: { source: { panelId: panel.id }, actionId: 'refresh' },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([202, 202, 429]);
  });

  it('supports deferred answers and follow-ups for button clicks', async () => {
    const w = await world();
    let payload: ActionPayload | undefined;
    answer((p) => {
      payload = p;
      return { body: { type: 'deferred' } };
    });
    await w.clickPanel(w.alice, 'refresh', 'n-d');
    const [pending] = await w.aliceSocket.waitFor('interaction.pending');
    expect(pending).toMatchObject({ kind: 'action', command: 'Refresh', nonce: 'n-d' });
    await settle(50);
    const followup = await fetch(
      `${target.url}/api/interactions/${payload?.id}/${payload?.token}/followup`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'done', ephemeral: true }),
      },
    );
    expect(followup.status).toBe(201);
    const [frame] = await w.aliceSocket.waitFor('interaction.ephemeral');
    expect(frame).toMatchObject({ content: 'done', kind: 'action' });
  });

  it('answers failed when the bot cannot be reached', async () => {
    const w = await world();
    answer(() => ({ status: 500, body: {} }));
    await w.clickPanel(w.alice, 'refresh', 'n-f');
    const [failed] = await w.aliceSocket.waitFor('interaction.failed');
    expect(failed).toMatchObject({ reason: 'bad_status', kind: 'action', nonce: 'n-f' });
  });
});
