import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Message } from '@harmony/shared';
import { enqueueEvent } from '../../src/events/outbox.js';
import {
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

describe('transactional outbox', () => {
  let infra: Infra;
  let target: TestApp;
  let listener: pg.Client;
  const notifications: string[] = [];

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp();
    listener = new pg.Client({ connectionString: inject('databaseUrl') });
    await listener.connect();
    await listener.query('LISTEN harmony_events');
    listener.on('notification', (n) => notifications.push(n.channel));
  });
  afterAll(async () => {
    await listener.end();
    await infra.stop();
  });

  const outbox = (guildId: string) =>
    infra.db
      .selectFrom('event_outbox')
      .selectAll()
      .where('guild_id', '=', guildId)
      .orderBy('id')
      .execute();

  async function world() {
    const owner = `owner-${uid()}@example.com`;
    const member = `member-${uid()}@example.com`;
    const guildId = await createGuild(infra.db, owner, [member]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    return { owner, member, guildId, channelId };
  }

  it('commits the event with the change and notifies the worker', async () => {
    const w = await world();
    notifications.length = 0;
    await infra.db.transaction().execute(async (trx) => {
      await enqueueEvent(trx, { guildId: w.guildId, type: 'message.deleted', data: { ok: true } });
    });
    await settle(200);
    expect(await outbox(w.guildId)).toHaveLength(1);
    expect(notifications).toContain('harmony_events');
  });

  it('writes no event and sends no notification when the transaction rolls back', async () => {
    const w = await world();
    const authorId = await ensureUser(infra.db, w.owner);
    notifications.length = 0;
    await expect(
      infra.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('messages')
          .values({
            channel_id: w.channelId,
            author_id: authorId,
            content: 'will be rolled back',
            reply_to_id: null,
            edited_at: null,
            deleted_at: null,
            pinned_at: null,
            pinned_by: null,
          })
          .execute();
        await enqueueEvent(trx, {
          guildId: w.guildId,
          channelId: w.channelId,
          type: 'message.created',
          data: { content: 'will be rolled back' },
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    await settle(200);
    expect(await outbox(w.guildId)).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    const rows = await infra.db
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', w.channelId)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('writes nothing when a send fails inside the service', async () => {
    const w = await world();
    const res = await api(target, w.owner)(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      body: { content: 'reply to nothing', replyToId: '999999999' },
    });
    expect(res.status).toBe(400);
    expect(await outbox(w.guildId)).toHaveLength(0);
  });

  it('records every event type in the same transaction as the change', async () => {
    const w = await world();
    const owner = api(target, w.owner);
    const sent = await owner(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      body: { content: 'first' },
    });
    const messageId = (sent.body as Message).id;
    await owner(`/api/messages/${messageId}`, { method: 'PATCH', body: { content: 'edited' } });
    await owner(`/api/messages/${messageId}/pin`, { method: 'PUT' });
    const thumbs = '%F0%9F%91%8D';
    await owner(`/api/messages/${messageId}/reactions/${thumbs}`, { method: 'PUT' });
    await owner(`/api/messages/${messageId}/reactions/${thumbs}`, { method: 'PUT' });
    await owner(`/api/messages/${messageId}/reactions/${thumbs}`, { method: 'DELETE' });
    await owner(`/api/messages/${messageId}/reactions/${thumbs}`, { method: 'DELETE' });
    await owner(`/api/messages/${messageId}`, { method: 'DELETE' });
    await owner(`/api/messages/${messageId}`, { method: 'DELETE' });

    const joiner = `joiner-${uid()}@example.com`;
    await ensureUser(infra.db, joiner);
    const invite = await owner(`/api/guilds/${w.guildId}/invites`, { method: 'POST', body: {} });
    const code = (invite.body as { code: string }).code;
    await api(target, joiner)(`/api/invites/${code}/accept`, { method: 'POST' });
    await api(target, joiner)(`/api/invites/${code}/accept`, { method: 'POST' });
    await api(target, joiner)(`/api/guilds/${w.guildId}/leave`, { method: 'POST' });

    const events = await outbox(w.guildId);
    expect(events.map((e) => e.type)).toEqual([
      'message.created',
      'message.updated',
      'message.updated',
      'reaction.added',
      'reaction.removed',
      'message.deleted',
      'guild.member_joined',
      'guild.member_left',
    ]);
    const [created, , , reaction, , deleted, joined, left] = events;
    expect((created?.payload as { message: Message }).message).toMatchObject({
      id: messageId,
      content: 'first',
    });
    expect(created?.channel_id).toBe(w.channelId);
    expect(reaction?.payload).toMatchObject({ messageId, emoji: '👍', channelId: w.channelId });
    expect(deleted?.payload).toEqual({ channelId: w.channelId, messageId });
    expect(joined?.payload).toMatchObject({ user: { login: joiner } });
    expect(joined?.channel_id).toBeNull();
    expect(left?.payload).toEqual({ userId: await ensureUser(infra.db, joiner) });
    expect(events.every((e) => e.fanned_out_at === null)).toBe(true);
  });

  it('records no events for DMs', async () => {
    const w = await world();
    const dm = await api(target, w.owner)('/api/dms', {
      method: 'POST',
      body: { userId: await ensureUser(infra.db, w.member) },
    });
    const before = await outbox(w.guildId);
    await api(target, w.owner)(`/api/channels/${(dm.body as { id: string }).id}/messages`, {
      method: 'POST',
      body: { content: 'private chat' },
    });
    expect(await outbox(w.guildId)).toHaveLength(before.length);
    const dmEvents = await infra.db
      .selectFrom('event_outbox')
      .select('id')
      .where('channel_id', '=', (dm.body as { id: string }).id)
      .execute();
    expect(dmEvents).toHaveLength(0);
  });
});
