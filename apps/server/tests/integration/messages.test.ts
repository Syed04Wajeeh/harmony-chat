import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ListMessagesResponse, Message } from '@harmony/shared';
import {
  addMember,
  api,
  createChannel,
  createInfra,
  type Infra,
  type TestApp,
} from './support/harness.js';

describe('channels and message history', () => {
  let infra: Infra;
  let target: TestApp;
  let call: ReturnType<typeof api>;
  let channelId: string;

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ MESSAGE_RATE_MAX: '1000' });
    call = api(target, 'history@example.com');
    channelId = await createChannel(infra.db, ['history@example.com']);
  });

  afterAll(() => infra.stop());

  const page = async (query = '') =>
    (await call(`/api/channels/${channelId}/messages${query}`)).body as ListMessagesResponse;

  it('lists the channels the user belongs to', async () => {
    const { status, body } = await call('/api/channels');
    expect(status).toBe(200);
    expect((body as { channels: { id: string }[] }).channels.map((c) => c.id)).toContain(channelId);
  });

  it('posts a message and returns it with its author', async () => {
    const { status, body } = await call(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content: '  first  ', nonce: 'n1' },
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      channelId,
      content: 'first',
      author: { login: 'history@example.com' },
    });
  });

  it('validates the body', async () => {
    for (const payload of [{}, { content: '   ' }, { content: 'x'.repeat(4001) }]) {
      const res = await call(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        body: payload,
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_request' });
    }
  });

  it('returns 404 for an unknown channel', async () => {
    const read = await call('/api/channels/999999999/messages');
    expect(read.status).toBe(404);
    const write = await call('/api/channels/999999999/messages', {
      method: 'POST',
      body: { content: 'hi' },
    });
    expect(write.status).toBe(404);
    expect(write.body).toMatchObject({ code: 'channel_not_found' });
  });

  it('paginates with a keyset cursor, oldest first within each page', async () => {
    for (let i = 2; i <= 25; i++) {
      await call(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        body: { content: `m${i}` },
      });
    }

    const newest = await page('?limit=10');
    expect(newest.hasMore).toBe(true);
    expect(newest.messages.map((m) => m.content)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i + 16}`),
    );

    const seen: Message[] = [...newest.messages];
    let cursor = newest.messages[0]?.id;
    let hasMore = newest.hasMore;
    while (hasMore) {
      const older = await page(`?limit=10&before=${cursor}`);
      seen.unshift(...older.messages);
      cursor = older.messages[0]?.id;
      hasMore = older.hasMore;
    }

    expect(seen).toHaveLength(25);
    expect(seen[0]?.content).toBe('first');
    const ids = seen.map((m) => BigInt(m.id));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)));
    expect(new Set(ids).size).toBe(25);
  });

  it('reports hasMore=false when the page is exactly full', async () => {
    const all = await page('?limit=25');
    expect(all.messages).toHaveLength(25);
    expect(all.hasMore).toBe(false);
  });

  it('defaults the limit to 50 and rejects out-of-range limits', async () => {
    expect((await page()).messages).toHaveLength(25);
    expect((await call(`/api/channels/${channelId}/messages?limit=0`)).status).toBe(400);
    expect((await call(`/api/channels/${channelId}/messages?limit=101`)).status).toBe(400);
  });

  it('serves soft-deleted messages as empty tombstones', async () => {
    const before = await page();
    const victim = before.messages[3];
    await infra.db
      .updateTable('messages')
      .set({ deleted_at: new Date() })
      .where('id', '=', victim?.id ?? '0')
      .execute();
    const after = await page();
    expect(after.messages).toHaveLength(25);
    expect(after.messages.find((m) => m.id === victim?.id)).toMatchObject({
      content: '',
      deleted: true,
    });
  });

  it('rate limits message sends per user over REST', async () => {
    const limited = await infra.startApp({
      MESSAGE_RATE_MAX: '3',
      MESSAGE_RATE_WINDOW_SECONDS: '30',
    });
    const login = `limited-${Date.now()}@example.com`;
    await addMember(infra.db, channelId, login);
    const send = api(limited, login);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (
          await send(`/api/channels/${channelId}/messages`, {
            method: 'POST',
            body: { content: 'x' },
          })
        ).status,
      );
    }
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
  });
});
