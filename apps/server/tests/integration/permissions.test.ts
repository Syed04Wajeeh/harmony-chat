import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  type ChannelOverwrite,
  type GuildMember,
  type ListMessagesResponse,
  type Message,
  type Role,
} from '@harmony/shared';
import { addBotToGuild, botApi, createBot } from './support/bots.js';
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

const uid = () => randomUUID().slice(0, 8);

describe('roles and permissions', () => {
  let infra: Infra;
  let target: TestApp;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ MESSAGE_RATE_MAX: '1000', COMMAND_RATE_MAX: '1000' });
  });
  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  /** A guild with an owner, three members and a public channel holding one message from bob. */
  async function world(at: TestApp = target) {
    const owner = `owner-${uid()}@example.com`;
    const alice = `alice-${uid()}@example.com`;
    const bob = `bob-${uid()}@example.com`;
    const carol = `carol-${uid()}@example.com`;
    const ownerId = await ensureUser(infra.db, owner);
    const guildId = await createGuild(infra.db, owner, [alice, bob, carol]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const ids = {
      owner: ownerId,
      alice: await ensureUser(infra.db, alice),
      bob: await ensureUser(infra.db, bob),
      carol: await ensureUser(infra.db, carol),
    };
    const as = (login: string, on: TestApp = at) => api(on, login);
    const sent = await as(bob)(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content: 'hello from bob' },
    });
    const messageId = (sent.body as Message).id;
    const roles = async () =>
      ((await as(owner)(`/api/guilds/${guildId}/roles`)).body as { roles: Role[] }).roles;
    const everyone = async () => (await roles()).find((r) => r.isDefault) as Role;
    const makeRole = async (body: object, by = owner) => {
      const res = await as(by)(`/api/guilds/${guildId}/roles`, { method: 'POST', body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body as Role;
    };
    const assign = (login: string, userId: string, roleId: string) =>
      as(login)(`/api/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: 'PUT' });
    const setEveryone = async (permissions: string[]) => {
      const res = await as(owner)(`/api/guilds/${guildId}/roles/${(await everyone()).id}`, {
        method: 'PATCH',
        body: { permissions },
      });
      expect(res.status).toBe(200);
    };
    const connect = async (login: string, on: TestApp = at) => {
      const socket = await TestSocket.connect(on, login);
      sockets.push(socket);
      return socket;
    };
    return {
      owner,
      alice,
      bob,
      carol,
      ids,
      guildId,
      channelId,
      messageId,
      as,
      roles,
      everyone,
      makeRole,
      assign,
      setEveryone,
      connect,
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  describe('what each permission guards', () => {
    interface Case {
      key: string;
      /** Runs the guarded action as `alice`; the returned status is what it answered. */
      act: (w: World) => Promise<{ status: number; body: unknown }>;
      /** Status once the permission is held (anything but 403 `missing_permission`). */
      ok: number;
      bobOnly?: boolean;
    }
    const cases: Case[] = [
      {
        key: 'send_messages',
        ok: 201,
        act: (w) =>
          w.as(w.alice)(`/api/channels/${w.channelId}/messages`, {
            method: 'POST',
            body: { content: 'hi' },
          }),
      },
      {
        key: 'attach_files',
        ok: 400,
        act: (w) =>
          w.as(w.alice)(`/api/channels/${w.channelId}/messages`, {
            method: 'POST',
            body: { content: 'file', attachmentIds: [randomUUID()] },
          }),
      },
      {
        key: 'add_reactions',
        ok: 204,
        act: (w) =>
          w.as(w.alice)(`/api/messages/${w.messageId}/reactions/${encodeURIComponent('👍')}`, {
            method: 'PUT',
          }),
      },
      {
        key: 'use_commands',
        ok: 200,
        act: async (w) => {
          const socket = await w.connect(w.alice);
          await socket.waitFor('hello');
          socket.send({
            type: 'command.invoke',
            channelId: w.channelId,
            name: 'coinflip',
            options: {},
            nonce: 'n1',
          });
          const deadline = Date.now() + 3000;
          while (socket.of('error').length === 0 && Date.now() < deadline) await settle(20);
          const error = socket.of('error')[0];
          return error?.code === 'missing_permission'
            ? { status: 403, body: error }
            : { status: 200, body: error };
        },
      },
      {
        key: 'manage_messages',
        ok: 204,
        act: (w) => w.as(w.alice)(`/api/messages/${w.messageId}`, { method: 'DELETE' }),
      },
      {
        key: 'pins.pin',
        ok: 200,
        act: (w) => w.as(w.alice)(`/api/messages/${w.messageId}/pin`, { method: 'PUT' }),
      },
      {
        key: 'polls.create',
        ok: 201,
        act: (w) =>
          w.as(w.alice)(`/api/channels/${w.channelId}/polls`, {
            method: 'POST',
            body: { question: 'Lunch?', options: ['Pizza', 'Ramen'] },
          }),
      },
      {
        key: 'create_channels',
        ok: 201,
        act: (w) =>
          w.as(w.alice)(`/api/guilds/${w.guildId}/channels`, {
            method: 'POST',
            body: { name: `c-${uid()}` },
          }),
      },
      {
        key: 'manage_channels',
        ok: 200,
        act: (w) =>
          w.as(w.alice)(`/api/channels/${w.channelId}`, {
            method: 'PATCH',
            body: { topic: 'new' },
          }),
      },
      {
        key: 'manage_roles',
        ok: 201,
        act: (w) =>
          w.as(w.alice)(`/api/guilds/${w.guildId}/roles`, {
            method: 'POST',
            body: { name: 'made by alice' },
          }),
      },
      {
        key: 'manage_guild',
        ok: 200,
        act: (w) =>
          w.as(w.alice)(`/api/guilds/${w.guildId}`, { method: 'PATCH', body: { name: 'Renamed' } }),
      },
      {
        key: 'manage_guild',
        ok: 201,
        act: (w) =>
          w.as(w.alice)(`/api/channels/${w.channelId}/webhooks`, {
            method: 'POST',
            body: { name: 'hook' },
          }),
      },
      {
        key: 'create_invites',
        ok: 201,
        act: (w) => w.as(w.alice)(`/api/guilds/${w.guildId}/invites`, { method: 'POST', body: {} }),
      },
      {
        key: 'kick_members',
        ok: 204,
        act: (w) =>
          w.as(w.alice)(`/api/guilds/${w.guildId}/members/${w.ids.carol}`, { method: 'DELETE' }),
      },
      {
        key: 'manage_nicknames',
        ok: 204,
        act: (w) =>
          w.as(w.alice)(`/api/guilds/${w.guildId}/members/${w.ids.bob}`, {
            method: 'PATCH',
            body: { nickname: 'Bobby' },
          }),
      },
      {
        key: 'change_nickname',
        ok: 204,
        act: (w) =>
          w.as(w.alice)(`/api/guilds/${w.guildId}/members/${w.ids.alice}`, {
            method: 'PATCH',
            body: { nickname: 'Ally' },
          }),
      },
    ];

    it.each(cases)('$key is refused without it and allowed with it', async (c) => {
      const w = await world();
      // Nobody holds it by default, so the first attempt must be refused.
      const everyone = await w.everyone();
      await w.setEveryone(everyone.permissions.filter((key) => key !== c.key));
      const refused = await c.act(w);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(JSON.stringify(refused.body)).toMatch(/missing_permission/);

      const role = await w.makeRole({ name: 'holder', permissions: [c.key] });
      expect((await w.assign(w.owner, w.ids.alice, role.id)).status).toBe(204);
      const allowed = await c.act(w);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(c.ok);
    });

    it('lets the owner and administrators through every guard', async () => {
      const w = await world();
      await w.setEveryone([]);
      const role = await w.makeRole({ name: 'root', permissions: ['administrator'] });
      await w.assign(w.owner, w.ids.alice, role.id);
      const res = await w.as(w.alice)(`/api/guilds/${w.guildId}`, {
        method: 'PATCH',
        body: { name: 'Admin was here' },
      });
      expect(res.status).toBe(200);
    });

    it('lets a member without view_channel in an overwrite neither read nor send', async () => {
      const w = await world();
      const everyone = await w.everyone();
      const put = await w.as(w.owner)(
        `/api/channels/${w.channelId}/overwrites/role/${everyone.id}`,
        { method: 'PUT', body: { deny: ['send_messages'] } },
      );
      expect(put.status).toBe(200);
      const send = await w.as(w.alice)(`/api/channels/${w.channelId}/messages`, {
        method: 'POST',
        body: { content: 'blocked' },
      });
      expect(send.status).toBe(403);
      const read = await w.as(w.alice)(`/api/channels/${w.channelId}/messages`);
      expect(read.status).toBe(200);
    });
  });

  describe('guild deletion and ownership', () => {
    it('keeps deleting a guild to its owner, whatever roles say', async () => {
      const w = await world();
      const role = await w.makeRole({ name: 'root', permissions: ['administrator'] });
      await w.assign(w.owner, w.ids.alice, role.id);
      expect((await w.as(w.alice)(`/api/guilds/${w.guildId}`, { method: 'DELETE' })).status).toBe(
        403,
      );
    });

    it('transfers ownership only on the owner’s say-so, and the old owner becomes a member', async () => {
      const w = await world();
      expect(
        (
          await w.as(w.alice)(`/api/guilds/${w.guildId}/transfer`, {
            method: 'POST',
            body: { userId: w.ids.alice },
          })
        ).status,
      ).toBe(403);
      const moved = await w.as(w.owner)(`/api/guilds/${w.guildId}/transfer`, {
        method: 'POST',
        body: { userId: w.ids.alice },
      });
      expect(moved.status).toBe(200);
      expect((moved.body as { ownerId: string }).ownerId).toBe(w.ids.alice);

      const rename = await w.as(w.owner)(`/api/guilds/${w.guildId}`, {
        method: 'PATCH',
        body: { name: 'mine still?' },
      });
      expect(rename.status).toBe(403);
      expect(
        (
          await w.as(w.alice)(`/api/guilds/${w.guildId}`, {
            method: 'PATCH',
            body: { name: 'Hers' },
          })
        ).status,
      ).toBe(200);
      expect((await w.as(w.alice)(`/api/guilds/${w.guildId}`, { method: 'DELETE' })).status).toBe(
        204,
      );
    });

    it('refuses to give a guild to a non-member', async () => {
      const w = await world();
      const stranger = await ensureUser(infra.db, `stranger-${uid()}@example.com`);
      const res = await w.as(w.owner)(`/api/guilds/${w.guildId}/transfer`, {
        method: 'POST',
        body: { userId: stranger },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('kicking', () => {
    it('removes the member, their channel rows and their roles, and tells them', async () => {
      const w = await world();
      const socket = await w.connect(w.carol);
      await socket.waitFor('hello');
      const role = await w.makeRole({ name: 'mod', permissions: ['kick_members'] });
      await w.assign(w.owner, w.ids.alice, role.id);
      const tagged = await w.makeRole({ name: 'tagged' });
      await w.assign(w.owner, w.ids.carol, tagged.id);

      const res = await w.as(w.alice)(`/api/guilds/${w.guildId}/members/${w.ids.carol}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(204);
      await socket.waitFor('guild.removed');
      expect((await w.as(w.carol)(`/api/channels/${w.channelId}/messages`)).status).toBe(403);
      const rows = await infra.db
        .selectFrom('member_roles')
        .select('role_id')
        .where('user_id', '=', w.ids.carol)
        .execute();
      expect(rows).toEqual([]);
      const members = (await w.as(w.owner)(`/api/guilds/${w.guildId}/members`)).body as {
        members: GuildMember[];
      };
      expect(members.members.map((m) => m.id)).not.toContain(w.ids.carol);
    });

    it('respects the hierarchy, the owner and yourself', async () => {
      const w = await world();
      const kicker = await w.makeRole({ name: 'kicker', permissions: ['kick_members'] });
      const high = await w.makeRole({ name: 'high' });
      // New roles land at the bottom, so reorder: high above kicker.
      const order = await w.as(w.owner)(`/api/guilds/${w.guildId}/roles/order`, {
        method: 'PATCH',
        body: { roleIds: [high.id, kicker.id] },
      });
      expect(order.status).toBe(200);
      await w.assign(w.owner, w.ids.alice, kicker.id);
      await w.assign(w.owner, w.ids.bob, high.id);

      const kick = (userId: string) =>
        w.as(w.alice)(`/api/guilds/${w.guildId}/members/${userId}`, { method: 'DELETE' });
      expect((await kick(w.ids.bob)).status).toBe(403);
      expect((await kick(w.ids.owner)).status).toBe(403);
      expect((await kick(w.ids.alice)).status).toBe(400);
      expect((await kick(w.ids.carol)).status).toBe(204);
    });
  });

  describe('role hierarchy', () => {
    it('only lets you edit, assign and delete roles below your highest', async () => {
      const w = await world();
      const manager = await w.makeRole({
        name: 'manager',
        permissions: ['manage_roles', 'manage_messages'],
      });
      const above = await w.makeRole({ name: 'above' });
      const below = await w.makeRole({ name: 'below' });
      // Top to bottom: above, manager, below.
      await w.as(w.owner)(`/api/guilds/${w.guildId}/roles/order`, {
        method: 'PATCH',
        body: { roleIds: [above.id, manager.id, below.id] },
      });
      await w.assign(w.owner, w.ids.alice, manager.id);

      const patch = (id: string, body: object) =>
        w.as(w.alice)(`/api/guilds/${w.guildId}/roles/${id}`, { method: 'PATCH', body });
      expect((await patch(above.id, { name: 'x' })).status).toBe(403);
      expect((await patch(manager.id, { name: 'x' })).status).toBe(403);
      expect((await patch(below.id, { name: 'ok' })).status).toBe(200);
      expect((await w.assign(w.alice, w.ids.bob, above.id)).status).toBe(403);
      expect((await w.assign(w.alice, w.ids.bob, below.id)).status).toBe(204);
      expect(
        (await w.as(w.alice)(`/api/guilds/${w.guildId}/roles/${above.id}`, { method: 'DELETE' }))
          .status,
      ).toBe(403);
    });

    it('does not let you grant permissions you do not hold', async () => {
      const w = await world();
      const manager = await w.makeRole({ name: 'manager', permissions: ['manage_roles'] });
      await w.assign(w.owner, w.ids.alice, manager.id);
      const res = await w.as(w.alice)(`/api/guilds/${w.guildId}/roles`, {
        method: 'POST',
        body: { name: 'sneaky', permissions: ['manage_guild'] },
      });
      expect(res.status).toBe(403);
      const ok = await w.as(w.alice)(`/api/guilds/${w.guildId}/roles`, {
        method: 'POST',
        body: { name: 'fine', permissions: ['manage_roles'] },
      });
      expect(ok.status).toBe(201);
    });

    it('keeps @everyone un-deletable and validates keys and ordering', async () => {
      const w = await world();
      const everyone = await w.everyone();
      expect(
        (await w.as(w.owner)(`/api/guilds/${w.guildId}/roles/${everyone.id}`, { method: 'DELETE' }))
          .status,
      ).toBe(400);
      expect(
        (
          await w.as(w.owner)(`/api/guilds/${w.guildId}/roles`, {
            method: 'POST',
            body: { name: 'bad', permissions: ['not_a_thing'] },
          })
        ).status,
      ).toBe(400);
      const one = await w.makeRole({ name: 'one' });
      expect(
        (
          await w.as(w.owner)(`/api/guilds/${w.guildId}/roles/order`, {
            method: 'PATCH',
            body: { roleIds: [one.id, one.id] },
          })
        ).status,
      ).toBe(400);
    });

    it('reports a member list with role ids, nickname and top role color', async () => {
      const w = await world();
      const red = await w.makeRole({ name: 'red', color: 0xff0000, hoist: true });
      await w.assign(w.owner, w.ids.alice, red.id);
      await w.as(w.alice)(`/api/guilds/${w.guildId}/members/${w.ids.alice}`, {
        method: 'PATCH',
        body: { nickname: 'Ally' },
      });
      const list = (await w.as(w.bob)(`/api/guilds/${w.guildId}/members`)).body as {
        members: GuildMember[];
      };
      const alice = list.members.find((m) => m.id === w.ids.alice);
      expect(alice).toMatchObject({ roleIds: [red.id], nickname: 'Ally', topRoleColor: 0xff0000 });
      const history = (await w.as(w.bob)(`/api/channels/${w.channelId}/messages`))
        .body as ListMessagesResponse;
      await w.as(w.alice)(`/api/channels/${w.channelId}/messages`, {
        method: 'POST',
        body: { content: 'named' },
      });
      const after = (await w.as(w.bob)(`/api/channels/${w.channelId}/messages`))
        .body as ListMessagesResponse;
      expect(after.messages.length).toBe(history.messages.length + 1);
      expect(after.messages.at(-1)?.authorNickname).toBe('Ally');
    });

    it('reports effective permissions for the caller, per channel', async () => {
      const w = await world();
      const everyone = await w.everyone();
      const base = (await w.as(w.alice)(`/api/guilds/${w.guildId}/permissions/@me`)).body as {
        permissions: string[];
        administrator: boolean;
      };
      expect(base.administrator).toBe(false);
      expect(base.permissions).toEqual(expect.arrayContaining(['send_messages']));
      await w.as(w.owner)(`/api/channels/${w.channelId}/overwrites/role/${everyone.id}`, {
        method: 'PUT',
        body: { deny: ['send_messages'] },
      });
      const scoped = (
        await w.as(w.alice)(`/api/guilds/${w.guildId}/permissions/@me?channelId=${w.channelId}`)
      ).body as { permissions: string[] };
      expect(scoped.permissions).not.toContain('send_messages');
      const owner = (await w.as(w.owner)(`/api/guilds/${w.guildId}/permissions/@me`)).body as {
        administrator: boolean;
        isOwner: boolean;
      };
      expect(owner).toMatchObject({ administrator: true, isOwner: true });
    });
  });

  describe('view_channel and channel_members', () => {
    it('removes and restores access, with events, when an overwrite hides a channel', async () => {
      const w = await world();
      const socket = await w.connect(w.alice);
      await socket.waitFor('hello');
      await socket.subscribe(w.channelId);
      const everyone = await w.everyone();

      const hide = await w.as(w.owner)(
        `/api/channels/${w.channelId}/overwrites/role/${everyone.id}`,
        { method: 'PUT', body: { deny: ['view_channel'] } },
      );
      expect(hide.status).toBe(200);
      const removed = await socket.waitFor('channel.removed');
      expect(removed[0]?.channelId).toBe(w.channelId);
      const rows = await infra.db
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', w.channelId)
        .execute();
      expect(rows.map((r) => r.user_id).sort()).toEqual([w.ids.owner]);
      expect((await w.as(w.alice)(`/api/channels/${w.channelId}/messages`)).status).toBe(403);

      // Hidden channels also stop live delivery to the socket that was subscribed.
      const before = socket.of('message.created').length;
      await w.as(w.owner)(`/api/channels/${w.channelId}/messages`, {
        method: 'POST',
        body: { content: 'secret' },
      });
      await settle();
      expect(socket.of('message.created').length).toBe(before);

      // A role that is allowed back in brings its holders with it.
      const insiders = await w.makeRole({ name: 'insiders' });
      await w.as(w.owner)(`/api/channels/${w.channelId}/overwrites/role/${insiders.id}`, {
        method: 'PUT',
        body: { allow: ['view_channel'] },
      });
      await w.assign(w.owner, w.ids.alice, insiders.id);
      const joined = await socket.waitFor('channel.joined');
      expect(joined[0]?.channel).toMatchObject({ id: w.channelId, isPrivate: true });
      expect((await w.as(w.alice)(`/api/channels/${w.channelId}/messages`)).status).toBe(200);
      expect((await w.as(w.bob)(`/api/channels/${w.channelId}/messages`)).status).toBe(403);
    });

    it('applies a guild-wide loss of view_channel to every channel and to new members', async () => {
      const w = await world();
      await w.setEveryone(['send_messages']);
      expect((await w.as(w.alice)(`/api/channels/${w.channelId}/messages`)).status).toBe(403);
      const late = `late-${uid()}@example.com`;
      const invite = await w.as(w.owner)(`/api/guilds/${w.guildId}/invites`, {
        method: 'POST',
        body: {},
      });
      await w.as(late)(`/api/invites/${(invite.body as { code: string }).code}/accept`, {
        method: 'POST',
      });
      expect((await w.as(late)(`/api/channels/${w.channelId}/messages`)).status).toBe(403);
      const open = await w.everyone();
      await w.setEveryone([...open.permissions, 'view_channel']);
      expect((await w.as(late)(`/api/channels/${w.channelId}/messages`)).status).toBe(200);
    });

    it('creates private channels as an @everyone deny plus a creator allow', async () => {
      const w = await world();
      const res = await w.as(w.alice)(`/api/guilds/${w.guildId}/channels`, {
        method: 'POST',
        body: { name: `p-${uid()}`, isPrivate: true },
      });
      expect(res.status).toBe(201);
      const id = (res.body as { id: string }).id;
      expect((await w.as(w.bob)(`/api/channels/${id}/messages`)).status).toBe(403);
      expect((await w.as(w.alice)(`/api/channels/${id}/messages`)).status).toBe(200);
      // The owner can see everything, so they are in too.
      expect((await w.as(w.owner)(`/api/channels/${id}/messages`)).status).toBe(200);

      const add = await w.as(w.alice)(`/api/channels/${id}/members`, {
        method: 'POST',
        body: { userId: w.ids.bob },
      });
      expect(add.status).toBe(204);
      expect((await w.as(w.bob)(`/api/channels/${id}/messages`)).status).toBe(200);
      const overwrites = (await w.as(w.owner)(`/api/channels/${id}/overwrites`)).body as {
        overwrites: ChannelOverwrite[];
      };
      expect(overwrites.overwrites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetType: 'member',
            targetId: w.ids.bob,
            allow: ['view_channel'],
          }),
        ]),
      );
      await w.as(w.alice)(`/api/channels/${id}/members/${w.ids.bob}`, { method: 'DELETE' });
      expect((await w.as(w.bob)(`/api/channels/${id}/messages`)).status).toBe(403);
    });
  });

  describe('bots', () => {
    it('need both the scope and the permission', async () => {
      const w = await world();
      const { bot, token } = await createBot(target, w.owner, { scopes: ['messages.write'] });
      await addBotToGuild(target, w.owner, w.guildId, bot.id);
      const post = () =>
        botApi(target, token)(`/api/channels/${w.channelId}/messages`, {
          method: 'POST',
          body: { content: 'beep' },
        });
      expect((await post()).status).toBe(201);

      const everyone = await w.everyone();
      await w.setEveryone(everyone.permissions.filter((key) => key !== 'send_messages'));
      const denied = await post();
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'missing_permission' });

      // The scope still matters when the permission is back.
      const muted = await createBot(target, w.owner, { scopes: ['messages.read'] });
      await addBotToGuild(target, w.owner, w.guildId, muted.bot.id);
      await w.setEveryone(everyone.permissions);
      const noScope = await botApi(target, muted.token)(`/api/channels/${w.channelId}/messages`, {
        method: 'POST',
        body: { content: 'beep' },
      });
      expect(noScope.body).toMatchObject({ code: 'missing_scope' });

      // And a role on the bot itself grants what @everyone no longer does.
      await w.setEveryone(everyone.permissions.filter((key) => key !== 'send_messages'));
      const speaker = await w.makeRole({ name: 'speakers', permissions: ['send_messages'] });
      expect((await w.assign(w.owner, bot.id, speaker.id)).status).toBe(204);
      expect((await post()).status).toBe(201);
    });
  });

  describe('migration defaults', () => {
    it('give a new guild exactly the documented @everyone permissions', async () => {
      const w = await world();
      const everyone = await w.everyone();
      expect([...everyone.permissions].sort()).toEqual([...DEFAULT_EVERYONE_PERMISSIONS].sort());
      expect(everyone).toMatchObject({ isDefault: true, position: 0, name: '@everyone' });
    });
  });

  describe('across instances', () => {
    it('takes effect on a second instance without a restart', async () => {
      const a = target;
      const b = await infra.startApp({ MESSAGE_RATE_MAX: '1000' });
      const w = await world(a);
      const sendOnB = () =>
        w.as(w.alice, b)(`/api/channels/${w.channelId}/messages`, {
          method: 'POST',
          body: { content: 'from b' },
        });
      expect((await sendOnB()).status).toBe(201); // warms B's cache

      const everyone = await w.everyone();
      await w.setEveryone(everyone.permissions.filter((key) => key !== 'send_messages'));
      let status = 201;
      for (let i = 0; i < 100 && status !== 403; i++) {
        status = (await sendOnB()).status;
        if (status !== 403) await settle(20);
      }
      expect(status).toBe(403);

      // And a role assigned on A is honoured on B.
      const role = await w.makeRole({ name: 'speaker', permissions: ['send_messages'] });
      await w.assign(w.owner, w.ids.alice, role.id);
      status = 403;
      for (let i = 0; i < 100 && status !== 201; i++) {
        status = (await sendOnB()).status;
        if (status !== 201) await settle(20);
      }
      expect(status).toBe(201);
    });
  });
});
