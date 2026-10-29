import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InteractionPayload, Message } from '@harmony/shared';
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
import { Receiver, addBotToGuild, bare, botApi, createBot, type Reply } from './support/bots.js';

const uid = () => randomUUID().slice(0, 8);

/** Built-in commands from modules are listed too; these tests are about the bots' commands. */
const botCommandNames = (body: unknown): string[] =>
  (body as { commands: { name: string; botId: string | null }[] }).commands
    .filter((command) => command.botId !== null)
    .map((command) => command.name);

describe('slash commands', () => {
  let infra: Infra;
  let target: TestApp;
  let receiver: Receiver;

  beforeAll(async () => {
    infra = createInfra();
    receiver = await Receiver.start();
    target = await infra.startApp({
      OUTBOUND_PRIVATE_ALLOWLIST: '127.0.0.1',
      INTERACTION_DEADLINE_MS: '600',
    });
  });
  afterAll(async () => {
    await infra.stop();
    await receiver.stop();
  });

  async function world() {
    const owner = `owner-${uid()}@example.com`;
    const alice = `alice-${uid()}@example.com`;
    const bob = `bob-${uid()}@example.com`;
    await ensureUser(infra.db, owner, { admin: true });
    const guildId = await createGuild(infra.db, owner, [alice, bob]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const created = await createBot(target, owner, {
      scopes: ['messages.read', 'messages.write', 'commands'],
      interactionsUrl: `${receiver.url}/interactions`,
    });
    await addBotToGuild(target, owner, guildId, created.bot.id);
    const asBot = botApi(target, created.token);
    const put = await asBot(`/api/bots/${created.bot.id}/guilds/${guildId}/commands`, {
      method: 'PUT',
      body: [
        {
          name: 'echo',
          description: 'Echo text',
          options: [{ name: 'text', description: 'What to say', type: 'string', required: true }],
        },
        {
          name: 'roll',
          description: 'Roll a die',
          options: [{ name: 'sides', description: 'Sides', type: 'integer' }],
        },
      ],
    });
    expect(put.status).toBe(200);
    const aliceSocket = await TestSocket.connect(target, alice);
    const bobSocket = await TestSocket.connect(target, bob);
    await aliceSocket.subscribe(channelId);
    await bobSocket.subscribe(channelId);
    const invoke = (login: string, body: unknown) =>
      api(target, login)(`/api/channels/${channelId}/commands`, { method: 'POST', body });
    return {
      owner,
      alice,
      bob,
      guildId,
      channelId,
      aliceSocket,
      bobSocket,
      asBot,
      invoke,
      ...created,
    };
  }

  type CommandPayload = Extract<InteractionPayload, { type: 'command' }>;
  const answer = (build: (payload: CommandPayload) => Reply) => {
    receiver.requests.length = 0;
    receiver.handler = (request) => build(JSON.parse(request.body) as CommandPayload);
  };

  it('registers commands by bulk overwrite and lists them for members', async () => {
    const w = await world();
    const listed = await api(target, w.alice)(`/api/guilds/${w.guildId}/commands`);
    expect(listed.status).toBe(200);
    expect(botCommandNames(listed.body)).toEqual(['echo', 'roll']);

    const overwrite = await w.asBot(`/api/bots/${w.bot.id}/guilds/${w.guildId}/commands`, {
      method: 'PUT',
      body: [{ name: 'ping', description: 'Ping' }],
    });
    expect(overwrite.status).toBe(200);
    const after = await api(target, w.alice)(`/api/guilds/${w.guildId}/commands`);
    expect(botCommandNames(after.body)).toEqual(['ping']);

    const outsider = `outsider-${uid()}@example.com`;
    await ensureUser(infra.db, outsider);
    expect((await api(target, outsider)(`/api/guilds/${w.guildId}/commands`)).status).toBe(403);
  });

  it('lets the owner register commands too, but not other bots or users', async () => {
    const w = await world();
    const owner = await api(target, w.owner)(`/api/bots/${w.bot.id}/guilds/${w.guildId}/commands`, {
      method: 'PUT',
      body: [{ name: 'hello', description: 'Hi' }],
    });
    expect(owner.status).toBe(200);
    const stranger = await api(target, w.alice)(
      `/api/bots/${w.bot.id}/guilds/${w.guildId}/commands`,
      {
        method: 'PUT',
        body: [],
      },
    );
    expect(stranger.status).toBe(404);
    const other = await createBot(target, w.owner, { scopes: ['commands'] });
    const impostor = await botApi(target, other.token)(
      `/api/bots/${w.bot.id}/guilds/${w.guildId}/commands`,
      { method: 'PUT', body: [] },
    );
    expect(impostor.status).toBe(403);
    const noScope = await createBot(target, w.owner, { scopes: ['messages.read'] });
    const denied = await botApi(target, noScope.token)(
      `/api/bots/${noScope.bot.id}/guilds/${w.guildId}/commands`,
      { method: 'PUT', body: [] },
    );
    expect(denied.body).toMatchObject({ code: 'missing_scope' });
  });

  it('requires the bot to be in the guild and keeps command names unique per guild', async () => {
    const w = await world();
    const stray = await createBot(target, w.owner, { scopes: ['commands'] });
    const notIn = await botApi(target, stray.token)(
      `/api/bots/${stray.bot.id}/guilds/${w.guildId}/commands`,
      { method: 'PUT', body: [{ name: 'x', description: 'y' }] },
    );
    expect(notIn.status).toBe(409);
    await addBotToGuild(target, w.owner, w.guildId, stray.bot.id);
    const clash = await botApi(target, stray.token)(
      `/api/bots/${stray.bot.id}/guilds/${w.guildId}/commands`,
      { method: 'PUT', body: [{ name: 'echo', description: 'stolen' }] },
    );
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: 'command_conflict' });
  });

  it('rejects malformed definitions', async () => {
    const w = await world();
    const put = (body: unknown) =>
      w.asBot(`/api/bots/${w.bot.id}/guilds/${w.guildId}/commands`, { method: 'PUT', body });
    expect((await put([{ name: 'Bad Name', description: 'x' }])).status).toBe(400);
    expect((await put([{ name: 'ok', description: 'd'.repeat(101) }])).status).toBe(400);
    expect(
      (
        await put([
          {
            name: 'ok',
            description: 'x',
            options: [{ name: 'a', description: 'x', type: 'float' }],
          },
        ])
      ).status,
    ).toBe(400);
  });

  it('signs the interaction request and answers immediately as the bot', async () => {
    const w = await world();
    answer((p) => ({
      body: { type: 'message', content: `echo: ${String(p.command.options.text)}` },
    }));
    const res = await w.invoke(w.alice, { name: 'echo', options: { text: 'hello' }, nonce: 'n-1' });
    expect(res.status).toBe(202);

    const [created] = await w.bobSocket.waitFor('message.created');
    expect(created?.message).toMatchObject({
      content: 'echo: hello',
      author: { id: w.bot.id, isBot: true },
    });
    expect(w.aliceSocket.of('message.created')).toHaveLength(1);

    const request = receiver.requests[0];
    expect(request).toBeDefined();
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
      type: 'command',
      guildId: w.guildId,
      channelId: w.channelId,
      command: { name: 'echo', options: { text: 'hello' } },
      user: { login: w.alice },
    });
    expect(payload.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payload.id).toBe((res.body as { interactionId: string }).interactionId);

    const stored = await infra.db
      .selectFrom('interactions')
      .select(['token_hash', 'expires_at', 'created_at'])
      .where('id', '=', payload.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).toHaveLength(32);
    expect(stored.expires_at.getTime() - stored.created_at.getTime()).toBeCloseTo(
      15 * 60 * 1000,
      -3,
    );
  });

  it('delivers an ephemeral answer only to the invoker and never persists it', async () => {
    const w = await world();
    answer(() => ({ body: { type: 'message', content: 'secret answer', ephemeral: true } }));
    await w.invoke(w.alice, { name: 'echo', options: { text: 'x' }, nonce: 'n-eph' });

    const [frame] = await w.aliceSocket.waitFor('interaction.ephemeral');
    expect(frame).toMatchObject({
      content: 'secret answer',
      channelId: w.channelId,
      command: 'echo',
      botId: w.bot.id,
      nonce: 'n-eph',
    });
    await settle(300);
    expect(w.bobSocket.of('interaction.ephemeral')).toHaveLength(0);
    expect(w.bobSocket.of('message.created')).toHaveLength(0);
    expect(w.aliceSocket.of('message.created')).toHaveLength(0);

    const history = await api(target, w.alice)(`/api/channels/${w.channelId}/messages`);
    expect((history.body as { messages: Message[] }).messages).toHaveLength(0);
    const rows = await infra.db
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', w.channelId)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('handles deferred answers with a follow-up using the interaction token', async () => {
    const w = await world();
    let payload: InteractionPayload | undefined;
    answer((p) => {
      payload = p;
      return { body: { type: 'deferred' } };
    });
    await w.invoke(w.alice, { name: 'roll', options: { sides: 20 }, nonce: 'n-def' });

    const [pending] = await w.aliceSocket.waitFor('interaction.pending');
    expect(pending).toMatchObject({ command: 'roll', botId: w.bot.id, nonce: 'n-def' });
    expect(new Date(pending?.expiresAt ?? 0).getTime()).toBeGreaterThan(
      Date.now() + 14 * 60 * 1000,
    );
    expect(w.bobSocket.of('interaction.pending')).toHaveLength(0);
    expect(w.bobSocket.of('message.created')).toHaveLength(0);

    const path = `/api/interactions/${payload?.id}/${payload?.token}/followup`;
    const wrong = await bare(
      target,
      `/api/interactions/${payload?.id}/${'A'.repeat(43)}/followup`,
      {
        body: { content: 'nope' },
      },
    );
    expect(wrong.status).toBe(401);

    const followup = await bare(target, path, { body: { content: 'rolled a 17' } });
    expect(followup.status).toBe(201);
    const [created] = await w.bobSocket.waitFor('message.created');
    expect(created?.message).toMatchObject({ content: 'rolled a 17', author: { id: w.bot.id } });

    const second = await bare(target, path, { body: { content: 'only you', ephemeral: true } });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ messageId: null });
    const [eph] = await w.aliceSocket.waitFor('interaction.ephemeral');
    expect(eph).toMatchObject({ content: 'only you', nonce: 'n-def' });
    expect(w.bobSocket.of('interaction.ephemeral')).toHaveLength(0);
  });

  it('refuses follow-ups after the 15 minute window', async () => {
    const w = await world();
    let payload: InteractionPayload | undefined;
    answer((p) => {
      payload = p;
      return { body: { type: 'deferred' } };
    });
    await w.invoke(w.alice, { name: 'roll', options: {} });
    await w.aliceSocket.waitFor('interaction.pending');
    await infra.db
      .updateTable('interactions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', payload?.id ?? '0')
      .execute();
    const late = await bare(target, `/api/interactions/${payload?.id}/${payload?.token}/followup`, {
      body: { content: 'too late' },
    });
    expect(late.status).toBe(410);
  });

  it('tells the invoker when the bot times out', async () => {
    const w = await world();
    answer(() => ({ delayMs: 1500, body: { type: 'message', content: 'too slow' } }));
    const started = Date.now();
    await w.invoke(w.alice, { name: 'echo', options: { text: 'x' }, nonce: 'n-slow' });
    const [failed] = await w.aliceSocket.waitFor('interaction.failed');
    expect(failed).toMatchObject({ reason: 'timeout', command: 'echo', nonce: 'n-slow' });
    expect(Date.now() - started).toBeLessThan(1400);
    await settle(1500);
    expect(w.bobSocket.of('message.created')).toHaveLength(0);
  });

  it('reports bad statuses, garbage and unreachable bots as failures', async () => {
    const w = await world();
    answer(() => ({ status: 500, body: { error: 'boom' } }));
    await w.invoke(w.alice, { name: 'echo', options: { text: 'x' } });
    await w.aliceSocket.waitFor('interaction.failed');
    expect(w.aliceSocket.of('interaction.failed')[0]?.reason).toBe('bad_status');

    answer(() => ({ rawBody: 'not json' }));
    await w.invoke(w.alice, { name: 'echo', options: { text: 'x' } });
    await w.aliceSocket.waitFor('interaction.failed', 2);
    expect(w.aliceSocket.of('interaction.failed')[1]?.reason).toBe('invalid_response');

    answer(() => ({ body: { type: 'message', content: '' } }));
    await w.invoke(w.alice, { name: 'echo', options: { text: 'x' } });
    await w.aliceSocket.waitFor('interaction.failed', 3);
    expect(w.aliceSocket.of('interaction.failed')[2]?.reason).toBe('invalid_response');

    await infra.db
      .updateTable('bots')
      .set({ interactions_url: 'http://127.0.0.1:1/nothing-here' })
      .where('user_id', '=', w.bot.id)
      .execute();
    await w.invoke(w.alice, { name: 'echo', options: { text: 'x' } });
    await w.aliceSocket.waitFor('interaction.failed', 4);
    expect(w.aliceSocket.of('interaction.failed')[3]?.reason).toBe('unreachable');
  });

  it('re-checks the URL at request time', async () => {
    const w = await world();
    await infra.db
      .updateTable('bots')
      .set({ interactions_url: 'http://169.254.169.254/latest/meta-data' })
      .where('user_id', '=', w.bot.id)
      .execute();
    await w.invoke(w.alice, { name: 'echo', options: { text: 'x' } });
    const [failed] = await w.aliceSocket.waitFor('interaction.failed');
    expect(failed?.reason).toBe('blocked_url');
  });

  it('does not call out to private addresses for bots whose owner is not an admin', async () => {
    const w = await world();
    await infra.db
      .updateTable('users')
      .set({ is_admin: false })
      .where('login', '=', w.owner)
      .execute();
    answer(() => ({ body: { type: 'message', content: 'should not happen' } }));
    await w.invoke(w.alice, { name: 'echo', options: { text: 'x' } });
    const [failed] = await w.aliceSocket.waitFor('interaction.failed');
    expect(failed?.reason).toBe('blocked_url');
    expect(receiver.requests).toHaveLength(0);
  });

  it('validates invocations before contacting the bot', async () => {
    const w = await world();
    answer(() => ({ body: { type: 'message', content: 'x' } }));
    const missing = await w.invoke(w.alice, { name: 'echo', options: {} });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'invalid_options' });
    expect((await w.invoke(w.alice, { name: 'roll', options: { sides: 'twenty' } })).status).toBe(
      400,
    );
    expect((await w.invoke(w.alice, { name: 'roll', options: { sides: 1.5 } })).status).toBe(400);
    expect((await w.invoke(w.alice, { name: 'roll', options: { nope: 1 } })).status).toBe(400);
    const unknown = await w.invoke(w.alice, { name: 'nothing', options: {} });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'unknown_command' });
    expect(receiver.requests).toHaveLength(0);
  });

  it('checks user and channel options against the guild', async () => {
    const w = await world();
    await w.asBot(`/api/bots/${w.bot.id}/guilds/${w.guildId}/commands`, {
      method: 'PUT',
      body: [
        {
          name: 'poke',
          description: 'Poke',
          options: [
            { name: 'who', description: 'Who', type: 'user', required: true },
            { name: 'where', description: 'Where', type: 'channel' },
          ],
        },
      ],
    });
    answer(() => ({ body: { type: 'message', content: 'poked' } }));
    const bobId = await ensureUser(infra.db, w.bob);
    const outsiderId = await ensureUser(infra.db, `outsider-${uid()}@example.com`);
    const foreign = await createChannel(infra.db, []);
    expect((await w.invoke(w.alice, { name: 'poke', options: { who: outsiderId } })).status).toBe(
      400,
    );
    expect(
      (await w.invoke(w.alice, { name: 'poke', options: { who: bobId, where: foreign } })).status,
    ).toBe(400);
    expect(
      (await w.invoke(w.alice, { name: 'poke', options: { who: bobId, where: w.channelId } }))
        .status,
    ).toBe(202);
  });

  it('requires channel membership and a guild channel to invoke', async () => {
    const w = await world();
    const outsider = `outsider-${uid()}@example.com`;
    await ensureUser(infra.db, outsider);
    expect((await w.invoke(outsider, { name: 'echo', options: { text: 'x' } })).status).toBe(403);
    const dm = await api(target, w.alice)('/api/dms', {
      method: 'POST',
      body: { userId: await ensureUser(infra.db, w.bob) },
    });
    const res = await api(target, w.alice)(
      `/api/channels/${(dm.body as { id: string }).id}/commands`,
      {
        method: 'POST',
        body: { name: 'echo', options: { text: 'x' } },
      },
    );
    expect(res.status).toBe(400);
  });

  it('keeps bots from invoking commands', async () => {
    const w = await world();
    const res = await w.asBot(`/api/channels/${w.channelId}/commands`, {
      method: 'POST',
      body: { name: 'echo', options: { text: 'x' } },
    });
    expect(res.body).toMatchObject({ code: 'human_only' });
  });

  it('runs commands over the WebSocket with command.invoke', async () => {
    const w = await world();
    answer((p) => ({ body: { type: 'message', content: `ws ${String(p.command.options.text)}` } }));
    w.aliceSocket.send({
      type: 'command.invoke',
      channelId: w.channelId,
      name: 'echo',
      options: { text: 'frame' },
      nonce: 'ws-1',
    });
    const [created] = await w.bobSocket.waitFor('message.created');
    expect(created?.message.content).toBe('ws frame');

    w.aliceSocket.send({
      type: 'command.invoke',
      channelId: w.channelId,
      name: 'ghost',
      options: {},
      nonce: 'ws-2',
    });
    const [error] = await w.aliceSocket.waitFor('error');
    expect(error).toMatchObject({ code: 'unknown_command', nonce: 'ws-2' });
  });

  it('rate-limits invocations per user', async () => {
    const limited = await infra.startApp({
      OUTBOUND_PRIVATE_ALLOWLIST: '127.0.0.1',
      COMMAND_RATE_MAX: '2',
    });
    const w = await world();
    answer(() => ({ body: { type: 'message', content: 'ok' } }));
    const alice = `fast-${uid()}@example.com`;
    await infra.db
      .insertInto('guild_members')
      .values({ guild_id: w.guildId, user_id: await ensureUser(infra.db, alice) })
      .execute();
    await infra.db
      .insertInto('channel_members')
      .values({
        channel_id: w.channelId,
        user_id: await ensureUser(infra.db, alice),
        last_read_message_id: null,
      })
      .execute();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await api(limited, alice)(`/api/channels/${w.channelId}/commands`, {
        method: 'POST',
        body: { name: 'echo', options: { text: 'x' } },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 2).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(2)).toEqual([429, 429]);
  });

  it('drops a bot’s commands when it is removed from the guild', async () => {
    const w = await world();
    const removed = await api(target, w.owner)(`/api/guilds/${w.guildId}/bots/${w.bot.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(204);
    const listed = await api(target, w.alice)(`/api/guilds/${w.guildId}/commands`);
    expect(botCommandNames(listed.body)).toEqual([]);
    expect((await w.invoke(w.alice, { name: 'echo', options: { text: 'x' } })).status).toBe(404);
  });
});
