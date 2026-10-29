import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ChannelSummary,
  GuildSummary,
  Message,
  Role,
  SendInvitesResponse,
} from '@harmony/shared';
import {
  TestSocket,
  api,
  createInfra,
  ensureUser,
  type Infra,
  type TestApp,
} from './support/harness.js';

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

describe('invite cards and the members directory', () => {
  let infra: Infra;
  let target: TestApp;
  const sockets: TestSocket[] = [];

  const guildOf = async (owner: string, name = 'Cards') =>
    (await api(target, owner)('/api/guilds', { method: 'POST', body: { name } }))
      .body as GuildSummary;
  const send = (login: string, guildId: string, userIds: string[]) =>
    api(target, login)(`/api/guilds/${guildId}/invites/send`, {
      method: 'POST',
      body: { userIds },
    });

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ MESSAGE_RATE_MAX: '1000', RATE_LIMIT_MAX: '10000' });
  });

  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  it('refuses people who may not create invites', async () => {
    const owner = unique('owner');
    const outsider = unique('outsider');
    const friend = unique('friend');
    const guild = await guildOf(owner);
    const friendId = await ensureUser(infra.db, friend);
    await ensureUser(infra.db, outsider);

    expect((await send(outsider, guild.id, [friendId])).status).toBe(403);

    // A member whose @everyone lost create_invites is refused too.
    const member = unique('member');
    const code = (
      await api(target, owner)(`/api/guilds/${guild.id}/invites`, { method: 'POST', body: {} })
    ).body as { code: string };
    await api(target, member)(`/api/invites/${code.code}/accept`, { method: 'POST' });
    const roles = (await api(target, owner)(`/api/guilds/${guild.id}/roles`)).body as {
      roles: Role[];
    };
    const everyone = roles.roles.find((r) => r.isDefault) as Role;
    await api(target, owner)(`/api/guilds/${guild.id}/roles/${everyone.id}`, {
      method: 'PATCH',
      body: { permissions: everyone.permissions.filter((p) => p !== 'create_invites') },
    });
    expect((await send(member, guild.id, [friendId])).status).toBe(403);
    expect((await send(owner, guild.id, [])).status).toBe(400);
    const dms = (await api(target, friend)('/api/dms')).body as { channels: ChannelSummary[] };
    expect(dms.channels).toEqual([]);
  });

  it('sends a DM with an invite card to each person, reusing one invite', async () => {
    const owner = unique('owner');
    const ada = unique('ada');
    const bo = unique('bo');
    const member = unique('member');
    const guild = await guildOf(owner);
    const [adaId, boId, memberId] = await Promise.all(
      [ada, bo, member].map((login) => ensureUser(infra.db, login)),
    );
    if (!adaId || !boId || !memberId) throw new Error('users missing');
    await api(target, member)(`/api/invites/${await codeFor(owner, guild.id)}/accept`, {
      method: 'POST',
    });

    const socket = await TestSocket.connect(target, ada);
    sockets.push(socket);
    await socket.waitFor('hello');

    const res = await send(owner, guild.id, [adaId, boId, memberId, adaId]);
    expect(res.status).toBe(200);
    const body = res.body as SendInvitesResponse;
    expect(body.sent.map((s) => s.userId).sort()).toEqual([adaId, boId].sort());
    expect(body.skipped).toEqual([{ userId: memberId, reason: 'already_member' }]);

    const adaDm = body.sent.find((s) => s.userId === adaId);
    if (!adaDm) throw new Error('no DM for ada');
    const history = (await api(target, ada)(`/api/channels/${adaDm.channelId}/messages`)).body as {
      messages: Message[];
    };
    const [card] = history.messages;
    expect(card?.embeds?.[0]).toMatchObject({ title: 'Cards', invite: { code: body.code } });
    expect(card?.content).toContain('invited you to join Cards');

    // The recipient is told about the new DM as it happens.
    await socket.waitFor('channel.joined');

    // The code on the card works with the normal accept flow.
    const accepted = await api(target, ada)(`/api/invites/${body.code}/accept`, { method: 'POST' });
    expect(accepted.status).toBe(200);

    // Sending again reuses the invite and the DM.
    const again = (await send(owner, guild.id, [boId])).body as SendInvitesResponse;
    expect(again.code).toBe(body.code);
    expect(again.sent[0]?.channelId).toBe(body.sent.find((s) => s.userId === boId)?.channelId);
    const invites = await infra.db
      .selectFrom('guild_invites')
      .select('code')
      .where('guild_id', '=', guild.id)
      .execute();
    expect(invites).toHaveLength(1);
  });

  it('does not let webhook or bot embeds fake a card', async () => {
    const owner = unique('owner');
    const guild = await guildOf(owner);
    const channels = (await api(target, owner)(`/api/guilds/${guild.id}/channels`)).body as {
      channels: ChannelSummary[];
    };
    const channelId = channels.channels[0]?.id;
    const sent = await api(target, owner)(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content: 'plain', embeds: [{ title: 'x', invite: { code: 'abc' } }] },
    });
    expect(sent.status).toBeLessThan(500);
    expect((sent.body as Message).embeds).toBeUndefined();
  });

  it('lists everyone who signed in, with a search and bots apart', async () => {
    const viewer = unique('viewer');
    const stranger = unique('zed-stranger');
    await ensureUser(infra.db, stranger);
    const asViewer = api(target, viewer);

    type Page = { users: { id: string; login: string; isBot?: boolean }[]; total: number };
    const page = (await asViewer('/api/directory?limit=2&offset=1')).body as Page;
    expect(page.users).toHaveLength(2);
    expect(page.total).toBeGreaterThan(3);
    expect(page.users.some((u) => u.isBot)).toBe(false);

    const found = (await asViewer('/api/directory?q=ZED-stranger')).body as Page;
    expect(found.users.map((u) => u.login)).toEqual([stranger]);
    expect(found.total).toBe(1);
    expect(((await asViewer('/api/directory?q=%25')).body as Page).total).toBe(0);
    expect((await asViewer('/api/directory?limit=1000')).status).toBe(400);

    // Strangers can be messaged straight from the directory.
    const strangerId = found.users[0]?.id;
    const dm = await asViewer('/api/dms', { method: 'POST', body: { userId: strangerId } });
    expect(dm.status).toBe(200);
  });

  async function codeFor(login: string, guildId: string): Promise<string> {
    const res = await api(target, login)(`/api/guilds/${guildId}/invites`, {
      method: 'POST',
      body: {},
    });
    return (res.body as { code: string }).code;
  }
});
