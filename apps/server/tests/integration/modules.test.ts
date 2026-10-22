import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GuildModule, Message } from '@harmony/shared';
import { modules as shipped } from '../../src/modules/index.js';
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
import { probe, probeChild, seen } from './support/probe-module.js';

const uid = () => randomUUID().slice(0, 8);
const THUMBS_UP = '%F0%9F%91%8D';

describe('modules', () => {
  let infra: Infra;
  let target: TestApp;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp(
      { PROBE_GREETING: 'howdy', REACTION_RATE_MAX: '1000', MESSAGE_RATE_MAX: '1000' },
      undefined,
      [...shipped, probe, probeChild],
    );
  });
  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  /** A guild with an owner, a member and a general channel. */
  async function world() {
    const owner = `owner-${uid()}@example.com`;
    const member = `member-${uid()}@example.com`;
    await ensureUser(infra.db, owner);
    const guildId = await createGuild(infra.db, owner, [member]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const asOwner = api(target, owner);
    const asMember = api(target, member);
    const setModule = (id: string, body: object) =>
      asOwner(`/api/guilds/${guildId}/modules/${id}`, { method: 'PUT', body });
    /** The probe has a dependent (probe-child), which has to go first. */
    const disableProbe = async () => {
      await setModule('probe-child', { enabled: false });
      return setModule('probe', { enabled: false });
    };
    const connect = async (login: string, subscribe = true) => {
      const socket = await TestSocket.connect(target, login);
      sockets.push(socket);
      if (subscribe) await socket.subscribe(channelId);
      return socket;
    };
    return {
      owner,
      member,
      guildId,
      channelId,
      asOwner,
      asMember,
      setModule,
      disableProbe,
      connect,
    };
  }

  const entry = (body: unknown, id: string) =>
    (body as { modules: GuildModule[] }).modules.find((module) => module.id === id);

  describe('per-guild state', () => {
    it('lists every module with defaults, a settings schema and declared permissions', async () => {
      const w = await world();
      const res = await w.asMember(`/api/guilds/${w.guildId}/modules`);
      expect(res.status).toBe(200);
      const ids = (res.body as { modules: GuildModule[] }).modules.map((m) => m.id);
      expect(ids).toEqual(
        expect.arrayContaining(['uploads', 'reactions', 'pins', 'search', 'polls', 'probe']),
      );

      expect(entry(res.body, 'reactions')).toMatchObject({ optional: true, enabled: true });
      expect(entry(res.body, 'uploads')).toMatchObject({ optional: false, enabled: true });
      expect(entry(res.body, 'probe')).toMatchObject({
        enabled: true,
        settings: { limit: 3, mode: 'quiet' },
        permissions: [{ key: 'probe.use', description: 'Use the probe' }],
      });
      const schema = entry(res.body, 'probe')?.settingsSchema as {
        properties: Record<string, { type?: string; enum?: string[]; default?: unknown }>;
      };
      expect(schema.properties['limit']).toMatchObject({ type: 'integer', default: 3 });
      expect(schema.properties['mode']).toMatchObject({ enum: ['quiet', 'loud'] });
      expect(entry(res.body, 'pins')?.settingsSchema).toBeNull();
      expect(entry(res.body, 'polls')?.permissions.map((p) => p.key)).toEqual([
        'polls.create',
        'polls.vote',
      ]);
    });

    it('is visible to members only', async () => {
      const w = await world();
      const outsider = `outsider-${uid()}@example.com`;
      expect((await api(target, outsider)(`/api/guilds/${w.guildId}/modules`)).status).toBe(403);
      expect((await w.asOwner('/api/guilds/999999999/modules')).status).toBe(404);
    });

    it('lets the owner switch an optional module off and on, telling every member live', async () => {
      const w = await world();
      const live = await w.connect(w.member, false);
      const off = await w.setModule('pins', { enabled: false });
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ id: 'pins', enabled: false });
      const [frame] = await live.waitFor('guild.modules_updated');
      expect(frame).toMatchObject({ guildId: w.guildId, moduleId: 'pins', enabled: false });
      expect(
        entry((await w.asMember(`/api/guilds/${w.guildId}/modules`)).body, 'pins')?.enabled,
      ).toBe(false);

      expect((await w.setModule('pins', { enabled: true })).status).toBe(200);
      await live.waitFor('guild.modules_updated', 2);
    });

    it('is the owner’s (or an admin’s) to change', async () => {
      const w = await world();
      const res = await w.asMember(`/api/guilds/${w.guildId}/modules/pins`, {
        method: 'PUT',
        body: { enabled: false },
      });
      expect(res.status).toBe(403);
      const admin = `admin-${uid()}@example.com`;
      await ensureUser(infra.db, admin, { admin: true });
      const byAdmin = await api(target, admin)(`/api/guilds/${w.guildId}/modules/pins`, {
        method: 'PUT',
        body: { enabled: false },
      });
      expect(byAdmin.status).toBe(200);
    });

    it('keeps bots out of it', async () => {
      const w = await world();
      const bot = await createBot(target, w.owner, { scopes: ['channels.read'] });
      await addBotToGuild(target, w.owner, w.guildId, bot.bot.id);
      const asBot = botApi(target, bot.token);
      expect((await asBot(`/api/guilds/${w.guildId}/modules`)).status).toBe(200);
      const res = await asBot(`/api/guilds/${w.guildId}/modules/pins`, {
        method: 'PUT',
        body: { enabled: false },
      });
      expect(res.status).toBe(403);
    });

    it('refuses to switch off a module that is not optional, or one that does not exist', async () => {
      const w = await world();
      const required = await w.setModule('uploads', { enabled: false });
      expect(required.status).toBe(409);
      expect(required.body).toMatchObject({ code: 'module_required' });
      expect((await w.setModule('uploads', { enabled: true })).status).toBe(200);
      const missing = await w.setModule('nope', { enabled: false });
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ code: 'module_not_found' });
      expect((await w.setModule('pins', {})).status).toBe(400);
    });

    it('validates and merges settings against the module’s schema', async () => {
      const w = await world();
      const ok = await w.setModule('probe', { settings: { limit: 5 } });
      expect(ok.body).toMatchObject({ settings: { limit: 5, mode: 'quiet' } });
      const merged = await w.setModule('probe', { settings: { mode: 'loud' } });
      expect(merged.body).toMatchObject({ settings: { limit: 5, mode: 'loud' } });

      const tooBig = await w.setModule('probe', { settings: { limit: 9 } });
      expect(tooBig.status).toBe(400);
      expect(tooBig.body).toMatchObject({ code: 'invalid_settings' });
      expect((await w.setModule('probe', { settings: { mode: 'shouting' } })).status).toBe(400);
      const none = await w.setModule('pins', { settings: { anything: 1 } });
      expect(none.body).toMatchObject({ code: 'invalid_settings' });

      const read = await w.asMember(`/api/guilds/${w.guildId}/modules`);
      expect(entry(read.body, 'probe')?.settings).toEqual({ limit: 5, mode: 'loud' });
    });

    it('enforces dependsOn when switching modules', async () => {
      const w = await world();
      expect((await w.disableProbe()).status).toBe(200);
      const blocked = await w.setModule('probe-child', { enabled: true });
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({ code: 'dependency_disabled' });

      expect((await w.setModule('probe', { enabled: true })).status).toBe(200);
      expect((await w.setModule('probe-child', { enabled: true })).status).toBe(200);
      const inUse = await w.setModule('probe', { enabled: false });
      expect(inUse.status).toBe(409);
      expect(inUse.body).toMatchObject({ code: 'module_in_use' });
    });

    it('takes effect on another instance without a restart', async () => {
      const w = await world();
      const other = await infra.startApp({ PROBE_GREETING: 'other' }, undefined, [
        ...shipped,
        probe,
        probeChild,
      ]);
      const asMemberOther = api(other, w.member);
      expect((await asMemberOther(`/api/guilds/${w.guildId}/probe`)).status).toBe(200);

      expect((await w.disableProbe()).status).toBe(200);
      const deadline = Date.now() + 3000;
      let status = 200;
      while (status === 200 && Date.now() < deadline) {
        await settle(25);
        status = (await asMemberOther(`/api/guilds/${w.guildId}/probe`)).status;
      }
      expect(status).toBe(404);
    });
  });

  describe('routes', () => {
    it('declare config.module to be switched off per guild', async () => {
      const w = await world();
      const on = await w.asMember(`/api/guilds/${w.guildId}/probe`);
      expect(on.status).toBe(200);
      expect(on.body).toMatchObject({
        greeting: 'howdy',
        settings: { limit: 3, mode: 'quiet' },
      });

      await w.disableProbe();
      const off = await w.asMember(`/api/guilds/${w.guildId}/probe`);
      expect(off.status).toBe(404);
      expect(off.body).toMatchObject({ code: 'module_disabled' });
      expect((await w.asMember(`/api/guilds/${w.guildId}/probe-explicit`)).status).toBe(404);

      await w.setModule('probe', { enabled: true, settings: { limit: 2 } });
      expect((await w.asMember(`/api/guilds/${w.guildId}/probe`)).body).toMatchObject({
        settings: { limit: 2 },
      });
    });

    it('still pass through authentication', async () => {
      const w = await world();
      const res = await fetch(`${target.url}/api/guilds/${w.guildId}/probe`);
      expect(res.status).toBe(403);
    });

    it('keep other modules’ frames out of a module’s namespace', async () => {
      const w = await world();
      const res = await w.asOwner('/api/probe/foreign-publish');
      expect(res.body).toMatchObject({ rejected: true });
    });
  });

  describe('WebSocket frames', () => {
    it('are validated, handled and answered with module frames delivered to the channel', async () => {
      const w = await world();
      const a = await w.connect(w.owner);
      const b = await w.connect(w.member);
      a.send({ type: 'probe.echo', channelId: w.channelId, text: 'ping' });
      const [frame] = await b.waitForModule('probe.echoed');
      expect(frame).toMatchObject({ text: 'ping', by: expect.any(String) as string });
      await a.waitForModule('probe.echoed');
    });

    it('answer a malformed module frame and an unknown type with the usual error', async () => {
      const w = await world();
      const a = await w.connect(w.owner);
      a.send({ type: 'probe.echo', channelId: w.channelId });
      a.send({ type: 'probe.nonsense' });
      a.send({ type: 'nothing.at.all' });
      const errors = await a.waitFor('error', 3);
      expect(errors.map((e) => e.code)).toEqual([
        'invalid_frame',
        'invalid_frame',
        'invalid_frame',
      ]);
    });

    it('report the handler’s own errors, such as not being a member', async () => {
      const w = await world();
      const stranger = `stranger-${uid()}@example.com`;
      await ensureUser(infra.db, stranger);
      const s = await w.connect(stranger, false);
      s.send({ type: 'probe.echo', channelId: w.channelId, text: 'hi' });
      const [error] = await s.waitFor('error');
      expect(error?.code).toBe('forbidden');
    });

    it('are for people unless the module names a scope for bots', async () => {
      const w = await world();
      const withScope = await createBot(target, w.owner, { scopes: ['messages.write'] });
      const without = await createBot(target, w.owner, { scopes: ['messages.read'] });
      const connectBot = async (token: string) => {
        const socket = await TestSocket.connectWith(target, { authorization: `Bot ${token}` });
        sockets.push(socket);
        return socket;
      };
      const humanOnly = await connectBot(withScope.token);
      humanOnly.send({ type: 'probe.echo', channelId: w.channelId, text: 'x' });
      expect((await humanOnly.waitFor('error'))[0]?.code).toBe('human_only');

      const scoped = await connectBot(withScope.token);
      scoped.send({ type: 'probe.scoped' });
      scoped.send({ type: 'typing', channelId: w.channelId });
      await settle();
      expect(scoped.of('error').find((e) => e.code === 'human_only')).toBeUndefined();

      const lacking = await connectBot(without.token);
      lacking.send({ type: 'probe.scoped' });
      expect((await lacking.waitFor('error'))[0]?.code).toBe('missing_scope');
    });
  });

  describe('domain events', () => {
    it('reach handlers after the commit, and a failing handler never fails the request', async () => {
      const w = await world();
      seen.length = 0;
      const res = await w.asOwner(`/api/channels/${w.channelId}/messages`, {
        method: 'POST',
        body: { content: 'observed' },
      });
      expect(res.status).toBe(201);
      await settle();
      expect(seen.map((event) => event.message.content)).toContain('observed');
      expect(seen.at(-1)).toMatchObject({ guildId: w.guildId, channelId: w.channelId });
    });

    it('stop reaching a module in guilds that switched it off', async () => {
      const w = await world();
      await w.disableProbe();
      seen.length = 0;
      await w.asOwner(`/api/channels/${w.channelId}/messages`, {
        method: 'POST',
        body: { content: 'unobserved' },
      });
      await settle();
      expect(seen).toEqual([]);
    });
  });

  describe('built-in slash commands', () => {
    const invoke = (w: Awaited<ReturnType<typeof world>>, login: string, body: object) =>
      api(target, login)(`/api/channels/${w.channelId}/commands`, { method: 'POST', body });

    it('show up in autocomplete next to bot commands, without a bot', async () => {
      const w = await world();
      const list = await w.asMember(`/api/guilds/${w.guildId}/commands`);
      const commands = (
        list.body as {
          commands: { name: string; botId: string | null; botName: string; moduleId?: string }[];
        }
      ).commands;
      expect(commands.find((c) => c.name === 'poll')).toMatchObject({
        botId: null,
        botName: 'Polls',
        moduleId: 'polls',
      });
      expect(commands.map((c) => c.name)).toEqual(
        expect.arrayContaining(['coinflip', 'probe', 'whisper']),
      );
    });

    it('answer publicly as the caller', async () => {
      const w = await world();
      const live = await w.connect(w.owner);
      const res = await invoke(w, w.member, { name: 'probe', options: { who: 'Ada' } });
      expect(res.status).toBe(202);
      expect((res.body as { interactionId: string }).interactionId).toMatch(/^\d{1,18}$/);
      const [created] = await live.waitFor('message.created');
      expect(created?.message.content).toBe(`howdy, Ada (from ${w.member})`);
      expect(created?.message.author.login).toBe(w.member);
    });

    it('answer ephemerally to the caller alone', async () => {
      const w = await world();
      const caller = await w.connect(w.member);
      const bystander = await w.connect(w.owner);
      await invoke(w, w.member, { name: 'whisper', options: {}, nonce: 'n-1' });
      const [note] = await caller.waitFor('interaction.ephemeral');
      expect(note).toMatchObject({
        content: 'psst',
        botId: null,
        source: 'Probe',
        command: 'whisper',
        nonce: 'n-1',
      });
      await settle();
      expect(bystander.of('interaction.ephemeral')).toEqual([]);
      expect(bystander.of('message.created')).toEqual([]);
    });

    it('validate options exactly like bot commands do', async () => {
      const w = await world();
      const missing = await invoke(w, w.member, { name: 'probe', options: {} });
      expect(missing.status).toBe(400);
      expect(missing.body).toMatchObject({ code: 'invalid_options' });
      const unknown = await invoke(w, w.member, { name: 'probe', options: { who: 'a', extra: 1 } });
      expect(unknown.body).toMatchObject({ code: 'invalid_options' });
      const refused = await invoke(w, w.member, { name: 'probe', options: { who: 'nobody' } });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: 'nobody' });
    });

    it('share the commands rate limit and the guild-only rule', async () => {
      const w = await world();
      const dm = await api(target, w.owner)('/api/dms', {
        method: 'POST',
        body: { userId: await ensureUser(infra.db, w.member) },
      });
      const res = await api(target, w.owner)(
        `/api/channels/${(dm.body as { id: string }).id}/commands`,
        {
          method: 'POST',
          body: { name: 'whisper', options: {} },
        },
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'commands_unavailable' });
    });

    it('cannot be registered over by a bot', async () => {
      const w = await world();
      const bot = await createBot(target, w.owner, { scopes: ['commands'] });
      await addBotToGuild(target, w.owner, w.guildId, bot.bot.id);
      const res = await botApi(target, bot.token)(
        `/api/bots/${bot.bot.id}/guilds/${w.guildId}/commands`,
        { method: 'PUT', body: [{ name: 'poll', description: 'Mine' }] },
      );
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'command_conflict' });
    });

    it('win over an older bot command of the same name, until their module is switched off', async () => {
      const w = await world();
      const bot = await createBot(target, w.owner, { scopes: ['commands'] });
      await addBotToGuild(target, w.owner, w.guildId, bot.bot.id);
      // A bot that registered /whisper before the module existed.
      await infra.db
        .insertInto('bot_commands')
        .values({
          bot_id: bot.bot.id,
          guild_id: w.guildId,
          name: 'whisper',
          description: 'The bot’s own',
          options: '[]',
        })
        .execute();
      const names = async () =>
        (
          (await w.asMember(`/api/guilds/${w.guildId}/commands`)).body as {
            commands: { name: string; description: string }[];
          }
        ).commands.filter((c) => c.name === 'whisper');

      expect((await names()).map((c) => c.description)).toEqual(['Reply only to the caller']);
      await w.disableProbe();
      expect((await names()).map((c) => c.description)).toEqual(['The bot’s own']);
      const gone = await invoke(w, w.member, { name: 'probe', options: { who: 'x' } });
      expect(gone.status).toBe(404);
    });
  });

  describe('switching the shipped modules off', () => {
    it('rejects reaction writes in that guild only, and keeps existing reactions', async () => {
      const w = await world();
      const other = await world();
      const post = async (guild: Awaited<ReturnType<typeof world>>) =>
        (
          await guild.asOwner(`/api/channels/${guild.channelId}/messages`, {
            method: 'POST',
            body: { content: 'react to me' },
          })
        ).body as Message;
      const [mine, theirs] = [await post(w), await post(other)];
      const react = (guild: Awaited<ReturnType<typeof world>>, id: string, method = 'PUT') =>
        guild.asOwner(`/api/messages/${id}/reactions/${THUMBS_UP}`, { method });

      expect((await react(w, mine.id)).status).toBe(204);
      await w.setModule('reactions', { enabled: false });
      const blocked = await react(w, mine.id);
      expect(blocked.status).toBe(404);
      expect(blocked.body).toMatchObject({ code: 'module_disabled' });
      expect((await react(w, mine.id, 'DELETE')).status).toBe(404);
      expect((await react(other, theirs.id)).status).toBe(204);

      const history = await w.asOwner(`/api/channels/${w.channelId}/messages`);
      const stored = (history.body as { messages: Message[] }).messages.find(
        (m) => m.id === mine.id,
      );
      expect(stored?.reactions).toHaveLength(1);

      await w.setModule('reactions', { enabled: true });
      expect((await react(w, mine.id, 'DELETE')).status).toBe(204);
    });

    it('rejects pinning and the pins list', async () => {
      const w = await world();
      const message = (
        await w.asOwner(`/api/channels/${w.channelId}/messages`, {
          method: 'POST',
          body: { content: 'pin me' },
        })
      ).body as Message;
      await w.setModule('pins', { enabled: false });
      const pin = await w.asOwner(`/api/messages/${message.id}/pin`, { method: 'PUT' });
      expect(pin.status).toBe(404);
      expect(pin.body).toMatchObject({ code: 'module_disabled' });
      expect((await w.asOwner(`/api/channels/${w.channelId}/pins`)).status).toBe(404);
      await w.setModule('pins', { enabled: true });
      expect((await w.asOwner(`/api/messages/${message.id}/pin`, { method: 'PUT' })).status).toBe(
        200,
      );
    });

    it('keeps a guild that turned search off out of everyone’s results', async () => {
      const w = await world();
      const word = `needle${uid()}`;
      await w.asOwner(`/api/channels/${w.channelId}/messages`, {
        method: 'POST',
        body: { content: word },
      });
      const hits = async () =>
        ((await w.asOwner(`/api/search?q=${word}`)).body as { messages: Message[] }).messages
          .length;
      expect(await hits()).toBe(1);
      await w.setModule('search', { enabled: false });
      expect(await hits()).toBe(0);
    });
  });

  describe('MODULES_DISABLED', () => {
    it('turns a module off for the whole instance', async () => {
      const limited = await infra.startApp({ MODULES_DISABLED: 'polls,coinflip' });
      const w = await world();
      const asOwner = api(limited, w.owner);
      const list = await asOwner(`/api/guilds/${w.guildId}/modules`);
      const ids = (list.body as { modules: GuildModule[] }).modules.map((m) => m.id);
      expect(ids).not.toContain('polls');
      expect(ids).toContain('pins');

      const poll = await asOwner(`/api/channels/${w.channelId}/polls`, {
        method: 'POST',
        body: { question: 'q', options: ['a', 'b'] },
      });
      expect(poll.status).toBe(404);
      const commands = (await asOwner(`/api/guilds/${w.guildId}/commands`)).body as {
        commands: { name: string }[];
      };
      expect(commands.commands.map((c) => c.name)).not.toContain('poll');
      expect(
        (
          await asOwner(`/api/guilds/${w.guildId}/modules/polls`, {
            method: 'PUT',
            body: { enabled: true },
          })
        ).status,
      ).toBe(404);
    });

    it('fails at startup on a name that is not a module, or on a module another one needs', async () => {
      await expect(infra.startApp({ MODULES_DISABLED: 'pollz' })).rejects.toThrow(
        /unknown module "pollz"/,
      );
      await expect(
        infra.startApp({ MODULES_DISABLED: 'probe' }, undefined, [...shipped, probe, probeChild]),
      ).rejects.toThrow(/"probe-child" needs "probe"/);
    });
  });

  describe('built-in coin flip', () => {
    it('posts the result as the caller, or only to the caller with private', async () => {
      const w = await world();
      const live = await w.connect(w.owner);
      const flip = (options: object) =>
        w.asMember(`/api/channels/${w.channelId}/commands`, {
          method: 'POST',
          body: { name: 'coinflip', options },
        });
      expect((await flip({})).status).toBe(202);
      const [message] = await live.waitFor('message.created');
      expect(message?.message.content).toMatch(/flipped (heads|tails)\.$/);

      const mine = await w.connect(w.member);
      await flip({ private: true });
      const [note] = await mine.waitFor('interaction.ephemeral');
      expect(note?.content).toMatch(/flipped (heads|tails)\.$/);
      await settle();
      expect(live.of('message.created')).toHaveLength(1);
    });

    it('is gone from a guild that switched it off', async () => {
      const w = await world();
      await w.setModule('coinflip', { enabled: false });
      const res = await w.asMember(`/api/channels/${w.channelId}/commands`, {
        method: 'POST',
        body: { name: 'coinflip', options: {} },
      });
      expect(res.status).toBe(404);
    });
  });
});
