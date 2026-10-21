import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelSummary, Message, ReadState } from '@harmony/shared';
import {
  TestSocket,
  api,
  createChannel,
  createInfra,
  ensureUser,
  insertMessages,
  settle,
  type Infra,
  type TestApp,
} from './support/harness.js';

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

describe('unread counts and read state', () => {
  let infra: Infra;
  let target: TestApp;
  const sockets: TestSocket[] = [];

  const connect = async (login: string) => {
    const socket = await TestSocket.connect(target, login);
    sockets.push(socket);
    await socket.waitFor('hello');
    return socket;
  };
  const summary = async (login: string, channelId: string) => {
    const { body } = await api(target, login)('/api/channels');
    const found = (body as { channels: ChannelSummary[] }).channels.find((c) => c.id === channelId);
    if (!found) throw new Error('channel missing from list');
    return found;
  };

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ MESSAGE_RATE_MAX: '1000', RATE_LIMIT_MAX: '10000' });
  });

  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  it("counts other people's messages after the read marker, not my own or deleted ones", async () => {
    const me = unique('me');
    const other = unique('other');
    const channelId = await createChannel(infra.db, [me, other]);
    const ids = await insertMessages(infra.db, channelId, other, 4);
    await insertMessages(infra.db, channelId, me, 2);

    expect(await summary(me, channelId)).toMatchObject({
      unreadCount: 4,
      mentionCount: 0,
      lastReadMessageId: null,
    });

    await api(target, other)(`/api/messages/${ids[0]}`, { method: 'DELETE' });
    const after = await summary(me, channelId);
    expect(after.unreadCount).toBe(3);
    expect(after.lastMessageId).not.toBeNull();
    expect((await summary(other, channelId)).unreadCount).toBe(2);
  });

  it('caps the count at 100 so a huge backlog stays cheap', async () => {
    const me = unique('me');
    const other = unique('other');
    const channelId = await createChannel(infra.db, [me, other]);
    const otherId = await ensureUser(infra.db, other);
    await infra.db
      .insertInto('messages')
      .values(
        Array.from({ length: 130 }, () => ({
          channel_id: channelId,
          author_id: otherId,
          content: 'backlog',
          reply_to_id: null,
          edited_at: null,
          deleted_at: null,
          pinned_at: null,
          pinned_by: null,
        })),
      )
      .execute();
    expect((await summary(me, channelId)).unreadCount).toBe(100);
  });

  it('counts mentions of me from channel members and ignores everyone else', async () => {
    const me = unique('me');
    const other = unique('other');
    const outsider = unique('outsider');
    const channelId = await createChannel(infra.db, [me, other]);
    const meId = await ensureUser(infra.db, me);
    const outsiderId = await ensureUser(infra.db, outsider);
    const mySocket = await connect(me);
    const outsiderSocket = await connect(outsider);

    const post = (content: string) =>
      api(target, other)(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        body: { content },
      });
    const mentioned = (await post(`hi <@${meId}> and <@${outsiderId}> and <@424242424>`))
      .body as Message;
    await post('no mention');

    expect(mentioned.mentions).toEqual([meId]);
    expect(await summary(me, channelId)).toMatchObject({ unreadCount: 2, mentionCount: 1 });
    expect((await mySocket.waitFor('mention'))[0]).toMatchObject({
      channelId,
      messageId: mentioned.id,
    });
    await settle();
    expect(outsiderSocket.of('mention')).toHaveLength(0);

    await post(`<@${other}> not a token <@${meId}`);
    expect((await summary(me, channelId)).mentionCount).toBe(1);
  });

  it('moves the read marker forward only and recomputes the counts', async () => {
    const me = unique('me');
    const other = unique('other');
    const channelId = await createChannel(infra.db, [me, other]);
    const ids = await insertMessages(infra.db, channelId, other, 5);
    const read = (messageId: string) =>
      api(target, me)(`/api/channels/${channelId}/read`, { method: 'POST', body: { messageId } });

    const first = await read(ids[2] ?? '');
    expect(first.body).toEqual({
      channelId,
      lastReadMessageId: ids[2],
      unreadCount: 2,
      mentionCount: 0,
    });
    const stale = await read(ids[0] ?? '');
    expect((stale.body as ReadState).lastReadMessageId).toBe(ids[2]);
    expect((stale.body as ReadState).unreadCount).toBe(2);
    expect(((await read(ids[4] ?? '')).body as ReadState).unreadCount).toBe(0);
    expect((await summary(me, channelId)).lastReadMessageId).toBe(ids[4]);
  });

  it('rejects marking a message from another channel, a missing one, or bad input', async () => {
    const me = unique('me');
    const channelId = await createChannel(infra.db, [me]);
    const elsewhere = await createChannel(infra.db, [me]);
    const [foreign] = await insertMessages(infra.db, elsewhere, me, 1);
    const read = (body: unknown) =>
      api(target, me)(`/api/channels/${channelId}/read`, { method: 'POST', body });

    expect((await read({ messageId: foreign })).status).toBe(400);
    expect((await read({ messageId: '999999999' })).status).toBe(400);
    expect((await read({ messageId: 'abc' })).status).toBe(400);
    expect((await read({})).status).toBe(400);
  });

  it('syncs read state to a second session of the same user, over REST and WebSocket', async () => {
    const me = unique('me');
    const other = unique('other');
    const channelId = await createChannel(infra.db, [me, other]);
    const ids = await insertMessages(infra.db, channelId, other, 3);
    const tab1 = await connect(me);
    const tab2 = await connect(me);
    const bystander = await connect(other);

    tab1.send({ type: 'read', channelId, messageId: ids[1] });
    const [first] = await tab2.waitFor('read.updated');
    expect(first).toMatchObject({ channelId, lastReadMessageId: ids[1], unreadCount: 1 });
    await tab1.waitFor('read.updated');

    await api(target, me)(`/api/channels/${channelId}/read`, {
      method: 'POST',
      body: { messageId: ids[2] },
    });
    expect((await tab2.waitFor('read.updated', 2))[1]).toMatchObject({ unreadCount: 0 });
    await settle();
    expect(bystander.of('read.updated')).toHaveLength(0);
  });

  it('starts new guild members caught up instead of unread', async () => {
    const author = unique('author');
    const joiner = unique('joiner');
    const channelId = await createChannel(infra.db, [author]);
    await insertMessages(infra.db, channelId, author, 5);
    const guildId = (
      await infra.db
        .selectFrom('channels')
        .select('guild_id')
        .where('id', '=', channelId)
        .executeTakeFirstOrThrow()
    ).guild_id;
    const invite = await api(target, author)(`/api/guilds/${guildId}/invites`, {
      method: 'POST',
      body: {},
    });
    await api(target, joiner)(`/api/invites/${(invite.body as { code: string }).code}/accept`, {
      method: 'POST',
    });
    expect(await summary(joiner, channelId)).toMatchObject({ unreadCount: 0, mentionCount: 0 });
  });
});
