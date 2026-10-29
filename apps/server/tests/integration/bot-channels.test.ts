import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Channel, Message, Role } from '@harmony/shared';
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
import { addBotToGuild, bare, botApi, createBot } from './support/bots.js';

const uid = () => randomUUID().slice(0, 8);

describe('bot channels and feed mode', () => {
  let infra: Infra;
  let target: TestApp;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ MESSAGE_RATE_MAX: '1000' });
  });
  afterAll(async () => {
    await Promise.all(sockets.map((socket) => socket.close()));
    await infra.stop();
  });

  async function world() {
    const owner = `owner-${uid()}@example.com`;
    const alice = `alice-${uid()}@example.com`;
    const mod = `mod-${uid()}@example.com`;
    const manager = `manager-${uid()}@example.com`;
    await ensureUser(infra.db, owner);
    const guildId = await createGuild(infra.db, owner, [alice, mod, manager]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const role = async (name: string, permissions: string[], login: string) => {
      const made = await api(target, owner)(`/api/guilds/${guildId}/roles`, {
        method: 'POST',
        body: { name, permissions },
      });
      expect(made.status).toBe(201);
      const userId = await ensureUser(infra.db, login);
      const assigned = await api(target, owner)(
        `/api/guilds/${guildId}/members/${userId}/roles/${(made.body as Role).id}`,
        { method: 'PUT' },
      );
      expect(assigned.status).toBe(204);
    };
    await role('Mods', ['manage_messages'], mod);
    await role('Managers', ['manage_channels'], manager);
    const bot = await createBot(target, owner, { name: 'Feed Bot' });
    await addBotToGuild(target, owner, guildId, bot.bot.id);
    const outsiderBot = await createBot(target, owner, { name: 'Elsewhere' });
    const channel = (login: string) => api(target, login);
    const assign = (login: string, botIds: string[], id = channelId) =>
      channel(login)(`/api/channels/${id}/bots`, { method: 'PUT', body: { botIds } });
    const feed = (login: string, botFeed: boolean) =>
      channel(login)(`/api/channels/${channelId}`, { method: 'PATCH', body: { botFeed } });
    const say = (login: string, content = 'hello') =>
      channel(login)(`/api/channels/${channelId}/messages`, { method: 'POST', body: { content } });
    return {
      owner,
      alice,
      mod,
      manager,
      guildId,
      channelId,
      bot,
      outsiderBot,
      assign,
      feed,
      say,
      asBot: botApi(target, bot.token),
    };
  }

  describe('assigning bots', () => {
    it('lets a manager assign, reorder and clear the guild’s bots, and shows them in the channel', async () => {
      const w = await world();
      const second = await createBot(target, w.owner, { name: 'Second' });
      await addBotToGuild(target, w.owner, w.guildId, second.bot.id);

      const first = await w.assign(w.manager, [second.bot.id, w.bot.bot.id]);
      expect(first.status).toBe(200);
      expect((first.body as Channel).botIds).toEqual([second.bot.id, w.bot.bot.id]);

      const listed = await api(target, w.alice)('/api/channels');
      const found = (listed.body as { channels: Channel[] }).channels.find(
        (c) => c.id === w.channelId,
      );
      expect(found?.botIds).toEqual([second.bot.id, w.bot.bot.id]);
      expect(found?.botFeed).toBe(false);

      expect((await w.assign(w.manager, [w.bot.bot.id])).status).toBe(200);
      const cleared = await w.assign(w.owner, []);
      expect((cleared.body as Channel).botIds).toEqual([]);
    });

    it('tells members live, through the channel update frame', async () => {
      const w = await world();
      const socket = await TestSocket.connect(target, w.alice);
      sockets.push(socket);
      await w.assign(w.manager, [w.bot.bot.id]);
      const [frame] = await socket.waitFor('channel.updated');
      expect(frame?.channel).toMatchObject({ id: w.channelId, botIds: [w.bot.bot.id] });
    });

    it('needs manage_channels (or being the creator)', async () => {
      const w = await world();
      const denied = await w.assign(w.alice, [w.bot.bot.id]);
      expect(denied.status).toBe(403);
      expect((denied.body as { code: string }).code).toBe('missing_permission');
      // Moderating messages is not managing channels.
      expect((await w.assign(w.mod, [w.bot.bot.id])).status).toBe(403);
      expect((await w.assign(w.owner, [w.bot.bot.id])).status).toBe(200);
    });

    it('refuses bots that are not in the guild, unknown ids and bot callers', async () => {
      const w = await world();
      const outside = await w.assign(w.owner, [w.outsiderBot.bot.id]);
      expect(outside.status).toBe(404);
      expect((outside.body as { code: string }).code).toBe('bot_not_found');
      expect((await w.assign(w.owner, ['999999999'])).status).toBe(404);
      const byBot = await w.asBot(`/api/channels/${w.channelId}/bots`, {
        method: 'PUT',
        body: { botIds: [] },
      });
      expect(byBot.status).toBe(403);
    });

    it('drops the assignment when the bot leaves the guild', async () => {
      const w = await world();
      await w.assign(w.owner, [w.bot.bot.id]);
      const removed = await api(target, w.owner)(`/api/guilds/${w.guildId}/bots/${w.bot.bot.id}`, {
        method: 'DELETE',
      });
      expect(removed.status).toBe(204);
      const rows = await infra.db
        .selectFrom('channel_bots')
        .selectAll()
        .where('channel_id', '=', w.channelId)
        .execute();
      expect(rows).toEqual([]);
    });
  });

  describe('feed mode', () => {
    it('is set by managers and shows in the channel summary', async () => {
      const w = await world();
      expect((await w.feed(w.alice, true)).status).toBe(403);
      const on = await w.feed(w.manager, true);
      expect(on.status).toBe(200);
      expect((on.body as Channel).botFeed).toBe(true);
      const listed = await api(target, w.alice)('/api/channels');
      expect(
        (listed.body as { channels: Channel[] }).channels.find((c) => c.id === w.channelId)
          ?.botFeed,
      ).toBe(true);
    });

    it('stops ordinary members from posting but lets bots, moderators and managers through', async () => {
      const w = await world();
      await w.feed(w.owner, true);

      const blocked = await w.say(w.alice);
      expect(blocked.status).toBe(403);
      expect((blocked.body as { code: string }).code).toBe('bot_feed');

      const byBot = await w.asBot(`/api/channels/${w.channelId}/messages`, {
        method: 'POST',
        body: { content: 'from the bot' },
      });
      expect(byBot.status).toBe(201);
      expect((await w.say(w.mod, 'moderator')).status).toBe(201);
      // The owner holds every permission, manage_messages included.
      expect((await w.say(w.owner, 'owner')).status).toBe(201);
      // A manager of channels who cannot manage messages is an ordinary poster here.
      expect((await w.say(w.manager)).status).toBe(403);
    });

    it('blocks the WebSocket send path the same way', async () => {
      const w = await world();
      await w.feed(w.owner, true);
      const socket = await TestSocket.connect(target, w.alice);
      sockets.push(socket);
      await socket.subscribe(w.channelId);
      socket.send({ type: 'message.send', channelId: w.channelId, content: 'hi', nonce: 'n1' });
      const [error] = await socket.waitFor('error');
      expect(JSON.stringify(error)).toContain('bot_feed');
    });

    it('still lets members react', async () => {
      const w = await world();
      const posted = await w.asBot(`/api/channels/${w.channelId}/messages`, {
        method: 'POST',
        body: { content: 'react to me' },
      });
      const message = posted.body as Message;
      await w.feed(w.owner, true);
      const reacted = await api(target, w.alice)(
        `/api/messages/${message.id}/reactions/${encodeURIComponent('👍')}`,
        { method: 'PUT' },
      );
      expect(reacted.status).toBe(204);
    });

    it('lets posting resume when it is switched off', async () => {
      const w = await world();
      await w.feed(w.owner, true);
      expect((await w.say(w.alice)).status).toBe(403);
      await w.feed(w.owner, false);
      expect((await w.say(w.alice)).status).toBe(201);
    });

    it('does not stop incoming webhooks', async () => {
      const w = await world();
      await w.feed(w.owner, true);
      const hook = await api(target, w.owner)(`/api/channels/${w.channelId}/webhooks`, {
        method: 'POST',
        body: { name: 'CI' },
      });
      expect(hook.status).toBe(201);
      const posted = await bare(target, (hook.body as { url: string }).url, {
        body: { content: 'build passed' },
      });
      expect(posted.status).toBeLessThan(300);
      const history = await api(target, w.owner)(`/api/channels/${w.channelId}/messages`);
      expect(JSON.stringify(history.body)).toContain('build passed');
    });
  });
});
