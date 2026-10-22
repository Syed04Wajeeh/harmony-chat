import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message } from '@harmony/shared';
import {
  PUBLIC_ORIGIN,
  TestSocket,
  api,
  createChannel,
  createGuild,
  createInfra,
  ensureUser,
  insertMessages,
  type Infra,
  type TestApp,
} from './support/harness.js';
import { addBotToGuild, botApi, createBot } from './support/bots.js';

const uid = () => randomUUID().slice(0, 8);

describe('bot accounts and authentication', () => {
  let infra: Infra;
  let target: TestApp;

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp();
  });
  afterAll(() => infra.stop());

  async function world(scopes?: string[]) {
    const owner = `owner-${uid()}@example.com`;
    const guildId = await createGuild(infra.db, owner);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const created = await createBot(target, owner, scopes ? { scopes } : {});
    await addBotToGuild(target, owner, guildId, created.bot.id);
    return { owner, guildId, channelId, ...created, as: botApi(target, created.token) };
  }

  it('creates a bot as a user of kind bot, showing secrets exactly once', async () => {
    const owner = `owner-${uid()}@example.com`;
    await ensureUser(infra.db, owner);
    const created = await createBot(target, owner, { name: 'Helper' });
    expect(created.token).toMatch(/^hb_\d+_[A-Za-z0-9_-]{43}$/);
    expect(created.token.split('_')[1]).toBe(created.bot.id);
    expect(created.signingSecret).toMatch(/^hsk_/);
    expect(created.bot).toMatchObject({
      name: 'Helper',
      scopes: ['messages.read', 'messages.write'],
      interactionsUrl: null,
      eventsUrl: null,
    });

    const row = await infra.db
      .selectFrom('users')
      .select(['kind', 'login', 'bot_owner_id'])
      .where('id', '=', created.bot.id)
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('bot');
    expect(row.login).toBe(`bot-${created.bot.id}@bots.harmony.invalid`);

    const stored = await infra.db
      .selectFrom('bots')
      .select('token_hash')
      .where('user_id', '=', created.bot.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).toHaveLength(32);
    expect(JSON.stringify(await api(target, owner)('/api/bots'))).not.toContain(created.token);
    const listed = await api(target, owner)('/api/bots');
    expect((listed.body as { bots: { id: string }[] }).bots.map((b) => b.id)).toContain(
      created.bot.id,
    );
  });

  it('keeps bots private to their owner', async () => {
    const owner = `owner-${uid()}@example.com`;
    const stranger = `stranger-${uid()}@example.com`;
    await ensureUser(infra.db, stranger);
    const { bot } = await createBot(target, owner);
    const asStranger = api(target, stranger);
    expect((await asStranger('/api/bots')).body).toEqual({ bots: [] });
    expect((await asStranger(`/api/bots/${bot.id}`)).status).toBe(404);
    expect((await asStranger(`/api/bots/${bot.id}/token`, { method: 'POST' })).status).toBe(404);
    expect((await asStranger(`/api/bots/${bot.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('updates and deletes a bot, keeping its messages', async () => {
    const w = await world();
    await w.as(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      body: { content: 'before delete' },
    });
    const patched = await api(target, w.owner)(`/api/bots/${w.bot.id}`, {
      method: 'PATCH',
      body: { name: 'Renamed', scopes: ['messages.read'] },
    });
    expect(patched.body).toMatchObject({ name: 'Renamed', scopes: ['messages.read'] });
    expect((await api(target, w.owner)(`/api/bots/${w.bot.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );

    expect((await w.as('/api/me')).status).toBe(401);
    const history = await api(target, w.owner)(`/api/channels/${w.channelId}/messages`);
    const messages = (history.body as { messages: Message[] }).messages;
    expect(messages.map((m) => m.content)).toContain('before delete');
    const members = await api(target, w.owner)(`/api/guilds/${w.guildId}/members`);
    expect(JSON.stringify(members.body)).not.toContain(`bot-${w.bot.id}@`);
  });

  it('authenticates REST calls by token alone', async () => {
    const w = await world();
    const me = await w.as('/api/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: w.bot.id, isBot: true });

    const sent = await w.as(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      body: { content: 'hello from a bot' },
    });
    expect(sent.status).toBe(201);
    expect((sent.body as Message).author).toMatchObject({ id: w.bot.id, isBot: true });
  });

  it('ignores Tailscale headers entirely when a bot token is present', async () => {
    const w = await world();
    await ensureUser(infra.db, 'admin@example.com', { admin: true });
    const res = await w.as('/api/me', {
      headers: {
        'tailscale-user-login': 'admin@example.com',
        'tailscale-user-name': 'Admin',
        'tailscale-funnel-request': '?1',
        'x-harmony-proxy-secret': 'wrong-secret',
        origin: 'https://evil.example',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: w.bot.id });

    const post = await w.as(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      body: { content: 'no origin needed' },
      headers: { 'tailscale-user-login': 'admin@example.com', origin: 'https://evil.example' },
    });
    expect(post.status).toBe(201);
    expect((post.body as Message).author.id).toBe(w.bot.id);
  });

  it('does not fall back to Tailscale identity when the token is wrong', async () => {
    const w = await world();
    const forged = w.token.slice(0, -3) + 'AAA';
    const res = await fetch(`${target.url}/api/me`, {
      headers: {
        authorization: `Bot ${forged}`,
        'tailscale-user-login': w.owner,
        'x-harmony-proxy-secret': 'x'.repeat(40),
        origin: PUBLIC_ORIGIN,
      },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'invalid_token' });
    for (const bad of ['Bot', 'Bot not-a-token', `Bot hb_999999999_${'a'.repeat(43)}`]) {
      const r = await fetch(`${target.url}/api/me`, { headers: { authorization: bad } });
      expect(r.status).toBe(401);
    }
  });

  it('refuses a human identity that claims a bot login', async () => {
    const w = await world();
    const res = await api(target, `bot-${w.bot.id}@bots.harmony.invalid`)('/api/me');
    expect(res.status).toBe(403);
  });

  it('enforces scopes on routes; humans ignore scopes', async () => {
    const w = await world(['messages.read']);
    const read = await w.as(`/api/channels/${w.channelId}/messages`);
    expect(read.status).toBe(200);
    const write = await w.as(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      body: { content: 'x' },
    });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ code: 'missing_scope' });
    const react = await w.as(`/api/messages/1/reactions/%F0%9F%91%8D`, { method: 'PUT' });
    expect(react.body).toMatchObject({ code: 'missing_scope' });
    expect((await w.as('/api/channels')).body).toMatchObject({ code: 'missing_scope' });

    const human = await api(target, w.owner)(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      body: { content: 'humans have no scopes' },
    });
    expect(human.status).toBe(201);
  });

  it('grants each scope its routes', async () => {
    const w = await world(['messages.read', 'messages.write', 'reactions.write', 'channels.read']);
    const sent = await w.as(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      body: { content: 'react to me' },
    });
    const id = (sent.body as Message).id;
    expect(
      (await w.as(`/api/messages/${id}/reactions/%F0%9F%91%8D`, { method: 'PUT' })).status,
    ).toBe(204);
    expect(
      (await w.as(`/api/messages/${id}`, { method: 'PATCH', body: { content: 'edited' } })).status,
    ).toBe(200);
    expect((await w.as('/api/channels')).status).toBe(200);
    expect((await w.as(`/api/guilds/${w.guildId}/members`)).status).toBe(200);
    expect((await w.as(`/api/search?q=edited`)).status).toBe(200);
  });

  it('keeps human-only endpoints closed to bots', async () => {
    const w = await world([
      'messages.read',
      'messages.write',
      'reactions.write',
      'channels.read',
      'commands',
      'events',
    ]);
    const calls: [string, string, unknown?][] = [
      ['POST', '/api/bots', { name: 'child' }],
      ['GET', '/api/bots'],
      ['POST', `/api/bots/${w.bot.id}/token`],
      ['POST', '/api/guilds', { name: 'nope' }],
      ['DELETE', `/api/guilds/${w.guildId}`],
      ['POST', `/api/guilds/${w.guildId}/invites`, {}],
      ['POST', '/api/invites/abc/accept'],
      ['POST', '/api/uploads'],
      ['POST', `/api/channels/${w.channelId}/webhooks`, { name: 'x' }],
      ['POST', `/api/channels/${w.channelId}/commands`, { name: 'x' }],
      ['PATCH', '/api/me', { status: 'dnd' }],
    ];
    for (const [method, path, body] of calls) {
      const res = await w.as(path, { method, ...(body !== undefined && { body }) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body, `${method} ${path}`).toMatchObject({ code: 'human_only' });
    }
  });

  it('cannot read guilds or channels it was not added to', async () => {
    const w = await world(['messages.read', 'messages.write', 'channels.read']);
    const otherOwner = `other-${uid()}@example.com`;
    const otherGuild = await createGuild(infra.db, otherOwner);
    const otherChannel = await createChannel(infra.db, [otherOwner], {
      guildId: otherGuild,
      createdBy: otherOwner,
    });
    await insertMessages(infra.db, otherChannel, otherOwner, 2);

    const guilds = await w.as('/api/guilds');
    expect((guilds.body as { guilds: { id: string }[] }).guilds.map((g) => g.id)).toEqual([
      w.guildId,
    ]);
    expect((await w.as(`/api/guilds/${otherGuild}/members`)).status).toBe(403);
    expect((await w.as(`/api/guilds/${otherGuild}/channels`)).status).toBe(403);
    expect((await w.as(`/api/channels/${otherChannel}/messages`)).status).toBe(403);
    expect(
      (
        await w.as(`/api/channels/${otherChannel}/messages`, {
          method: 'POST',
          body: { content: 'x' },
        })
      ).status,
    ).toBe(403);
    const search = await w.as('/api/search?q=seed');
    expect((search.body as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it('only the bot owner who also owns the guild can add it', async () => {
    const owner = `owner-${uid()}@example.com`;
    const other = `other-${uid()}@example.com`;
    const guildId = await createGuild(infra.db, other);
    await ensureUser(infra.db, owner);
    const { bot } = await createBot(target, owner);
    const res = await api(target, owner)(`/api/guilds/${guildId}/bots`, {
      method: 'POST',
      body: { botId: bot.id },
    });
    expect(res.status).toBe(403);
    const mine = await createGuild(infra.db, owner);
    const theirBot = await createBot(target, other);
    const stolen = await api(target, owner)(`/api/guilds/${mine}/bots`, {
      method: 'POST',
      body: { botId: theirBot.bot.id },
    });
    expect(stolen.status).toBe(404);
  });

  it('rotating the token revokes the old one immediately', async () => {
    const w = await world();
    expect((await w.as('/api/me')).status).toBe(200);
    const rotated = await api(target, w.owner)(`/api/bots/${w.bot.id}/token`, { method: 'POST' });
    expect(rotated.status).toBe(200);
    const fresh = (rotated.body as { token: string }).token;
    expect(fresh).not.toBe(w.token);
    expect((await w.as('/api/me')).status).toBe(401);
    expect((await botApi(target, fresh)('/api/me')).status).toBe(200);
  });

  it('records last_used_at, at most once a minute', async () => {
    const w = await world();
    await w.as('/api/me');
    const read = () =>
      infra.db
        .selectFrom('bots')
        .select('last_used_at')
        .where('user_id', '=', w.bot.id)
        .executeTakeFirstOrThrow();
    let first = (await read()).last_used_at;
    for (let i = 0; i < 40 && !first; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      first = (await read()).last_used_at;
    }
    expect(first).toBeInstanceOf(Date);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await w.as('/api/me');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await read()).last_used_at?.getTime()).toBe(first?.getTime());
  });

  it('rejects private and non-http URLs for non-admin owners', async () => {
    const owner = `owner-${uid()}@example.com`;
    await ensureUser(infra.db, owner);
    const as = api(target, owner);
    for (const url of [
      'http://10.0.0.5/hook',
      'http://127.0.0.1:9000/hook',
      'http://localhost:9000/hook',
      'http://169.254.169.254/latest',
      'http://100.100.100.100/hook',
      'http://[::1]/hook',
      'http://[::ffff:10.0.0.1]/hook',
      'http://2130706433/hook',
    ]) {
      const events = await as('/api/bots', {
        method: 'POST',
        body: { name: 'x', scopes: ['events'], eventsUrl: url },
      });
      expect(events.status, url).toBe(400);
      expect(events.body, url).toMatchObject({ code: 'url_not_allowed' });
      const interactions = await as('/api/bots', {
        method: 'POST',
        body: { name: 'x', scopes: ['commands'], interactionsUrl: url },
      });
      expect(interactions.body, url).toMatchObject({ code: 'url_not_allowed' });
    }
    const ftp = await as('/api/bots', {
      method: 'POST',
      body: { name: 'x', scopes: ['events'], eventsUrl: 'ftp://example.com/x' },
    });
    expect(ftp.status).toBe(400);

    const { bot } = await createBot(target, owner);
    const patch = await as(`/api/bots/${bot.id}`, {
      method: 'PATCH',
      body: { scopes: ['events'], eventsUrl: 'http://192.168.1.10/hook' },
    });
    expect(patch.body).toMatchObject({ code: 'url_not_allowed' });
    const ok = await as(`/api/bots/${bot.id}`, {
      method: 'PATCH',
      body: { scopes: ['events'], eventsUrl: 'https://93.184.216.34/hook' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ eventsUrl: 'https://93.184.216.34/hook' });
    expect((ok.body as { eventTypes: string[] }).eventTypes).toContain('message.created');
  });

  it('requires the matching scope for interactions and events URLs', async () => {
    const owner = `owner-${uid()}@example.com`;
    await ensureUser(infra.db, owner);
    const res = await api(target, owner)('/api/bots', {
      method: 'POST',
      body: { name: 'x', eventsUrl: 'https://93.184.216.34/hook' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_bot' });
  });

  it('rejects private URLs for non-admins even when the allowlist names them', async () => {
    const listed = await infra.startApp({ OUTBOUND_PRIVATE_ALLOWLIST: '10.0.0.0/8,127.0.0.1' });
    const user = `user-${uid()}@example.com`;
    await ensureUser(infra.db, user);
    const rejected = await api(listed, user)('/api/bots', {
      method: 'POST',
      body: { name: 'x', scopes: ['events'], eventsUrl: 'http://10.1.2.3/hook' },
    });
    expect(rejected.body).toMatchObject({ code: 'url_not_allowed' });

    const admin = `admin-${uid()}@example.com`;
    await ensureUser(infra.db, admin, { admin: true });
    const accepted = await api(listed, admin)('/api/bots', {
      method: 'POST',
      body: { name: 'x', scopes: ['events'], eventsUrl: 'http://10.1.2.3/hook' },
    });
    expect(accepted.status).toBe(201);
    const notListed = await api(listed, admin)('/api/bots', {
      method: 'POST',
      body: { name: 'x', scopes: ['events'], eventsUrl: 'http://172.20.0.1/hook' },
    });
    expect(notListed.body).toMatchObject({ code: 'url_not_allowed' });
  });

  describe('gateway', () => {
    it('authenticates the WebSocket with a token, ignoring Tailscale headers', async () => {
      const w = await world();
      const socket = await TestSocket.connectWith(target, {
        authorization: `Bot ${w.token}`,
        'tailscale-user-login': w.owner,
      });
      const [hello] = await socket.waitFor('hello');
      expect(hello?.user).toMatchObject({ id: w.bot.id, isBot: true });

      await socket.subscribe(w.channelId);
      socket.send({
        type: 'message.send',
        channelId: w.channelId,
        content: 'over ws',
        nonce: 'n1',
      });
      const [ack] = await socket.waitFor('ack');
      expect(ack?.message.author.id).toBe(w.bot.id);
      await socket.close();
    });

    it('rejects a bad token on the upgrade', async () => {
      await expect(
        TestSocket.connectWith(target, { authorization: `Bot hb_1_${'a'.repeat(43)}` }),
      ).rejects.toThrow('HTTP 401');
    });

    it('applies scopes to frames', async () => {
      const w = await world(['messages.read']);
      const socket = await TestSocket.connectWith(target, { authorization: `Bot ${w.token}` });
      await socket.waitFor('hello');
      await socket.subscribe(w.channelId);
      socket.send({ type: 'message.send', channelId: w.channelId, content: 'x', nonce: 'n2' });
      const [error] = await socket.waitFor('error');
      expect(error).toMatchObject({ code: 'missing_scope', nonce: 'n2' });
      socket.send({ type: 'presence.set', status: 'dnd' });
      await socket.waitFor('error', 2);
      expect(socket.of('error')[1]).toMatchObject({ code: 'human_only' });
      await socket.close();
    });

    it('does not let a bot subscribe to channels it cannot read', async () => {
      const w = await world();
      const otherOwner = `other-${uid()}@example.com`;
      const otherChannel = await createChannel(infra.db, [otherOwner]);
      const socket = await TestSocket.connectWith(target, { authorization: `Bot ${w.token}` });
      await socket.waitFor('hello');
      socket.send({ type: 'subscribe', channelId: otherChannel });
      const [error] = await socket.waitFor('error');
      expect(error?.code).toBe('forbidden');
      await socket.close();
    });
  });

  it('gives bots a separate, configurable rate-limit bucket', async () => {
    const limited = await infra.startApp({ BOT_RATE_LIMIT_MAX: '3' });
    const owner = `owner-${uid()}@example.com`;
    await ensureUser(infra.db, owner);
    const created = await createBot(limited, owner);
    const as = botApi(limited, created.token);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await as('/api/me')).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    // The owner's own bucket is untouched.
    expect((await api(limited, owner)('/api/me')).status).toBe(200);
  });
});
