import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Database } from '../../src/db/schema.js';
import type { ListMessagesResponse, Message } from '@harmony/shared';
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
const THUMBS_UP = '%F0%9F%91%8D';

describe('message features', () => {
  let infra: Infra;
  let target: TestApp;
  const sockets: TestSocket[] = [];

  const connect = async (login: string, channelId: string) => {
    const socket = await TestSocket.connect(target, login);
    sockets.push(socket);
    await socket.subscribe(channelId);
    return socket;
  };
  const setup = async (...logins: string[]) => {
    const channelId = await createChannel(infra.db, logins);
    const post = async (login: string, body: object): Promise<Message> =>
      (
        await api(target, login)(`/api/channels/${channelId}/messages`, {
          method: 'POST',
          body,
        })
      ).body as Message;
    return { channelId, post };
  };

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({
      MESSAGE_RATE_MAX: '1000',
      REACTION_RATE_MAX: '1000',
      RATE_LIMIT_MAX: '10000',
    });
  });

  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  describe('edit', () => {
    it('lets only the author edit and broadcasts message.updated', async () => {
      const [author, other] = [unique('author'), unique('other')];
      const { channelId, post } = await setup(author, other);
      const listener = await connect(other, channelId);
      const message = await post(author, { content: 'first' });

      const forbidden = await api(target, other)(`/api/messages/${message.id}`, {
        method: 'PATCH',
        body: { content: 'hijack' },
      });
      expect(forbidden.status).toBe(403);
      const edited = await api(target, author)(`/api/messages/${message.id}`, {
        method: 'PATCH',
        body: { content: ' second ' },
      });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({ id: message.id, content: 'second' });
      expect((edited.body as Message).editedAt).not.toBeNull();

      const [event] = await listener.waitFor('message.updated');
      expect(event?.message).toEqual(edited.body);
      expect(
        (
          await api(target, author)(`/api/messages/${message.id}`, {
            method: 'PATCH',
            body: { content: '  ' },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await api(target, author)('/api/messages/999999999', {
            method: 'PATCH',
            body: { content: 'x' },
          })
        ).status,
      ).toBe(404);
    });

    it('re-syncs mentions and only notifies newly mentioned users', async () => {
      const [author, a, b] = [unique('author'), unique('a'), unique('b')];
      const { channelId, post } = await setup(author, a, b);
      const [aId, bId] = await Promise.all([ensureUser(infra.db, a), ensureUser(infra.db, b)]);
      const sockA = await TestSocket.connect(target, a);
      const sockB = await TestSocket.connect(target, b);
      sockets.push(sockA, sockB);
      await Promise.all([sockA.waitFor('hello'), sockB.waitFor('hello')]);

      const message = await post(author, { content: `hi <@${aId}>` });
      await sockA.waitFor('mention');
      const edited = await api(target, author)(`/api/messages/${message.id}`, {
        method: 'PATCH',
        body: { content: `hi <@${aId}> and <@${bId}>` },
      });
      expect((edited.body as Message).mentions.sort()).toEqual([aId, bId].sort());
      await sockB.waitFor('mention');
      await settle();
      expect(sockA.of('mention')).toHaveLength(1);

      const dropped = await api(target, author)(`/api/messages/${message.id}`, {
        method: 'PATCH',
        body: { content: 'nobody' },
      });
      expect((dropped.body as Message).mentions).toEqual([]);
      expect(channelId).toBeTruthy();
    });
  });

  describe('delete', () => {
    it('soft-deletes for the author or an admin but not other members', async () => {
      const [author, other, root] = [unique('author'), unique('other'), unique('root')];
      await ensureUser(infra.db, root, { admin: true });
      const { channelId, post } = await setup(author, other);
      const listener = await connect(other, channelId);
      const [one, two] = [
        await post(author, { content: 'doomed' }),
        await post(author, { content: 'also doomed' }),
      ];

      expect(
        (await api(target, other)(`/api/messages/${one.id}`, { method: 'DELETE' })).status,
      ).toBe(403);
      expect(
        (await api(target, author)(`/api/messages/${one.id}`, { method: 'DELETE' })).status,
      ).toBe(204);
      expect(
        (await api(target, root)(`/api/messages/${two.id}`, { method: 'DELETE' })).status,
      ).toBe(204);
      expect(
        (await api(target, author)(`/api/messages/${one.id}`, { method: 'DELETE' })).status,
      ).toBe(204);

      const events = await listener.waitFor('message.deleted', 2);
      expect(events.map((e) => e.messageId)).toEqual([one.id, two.id]);
      await settle();
      expect(listener.of('message.deleted')).toHaveLength(2);

      const history = (await api(target, other)(`/api/channels/${channelId}/messages`))
        .body as ListMessagesResponse;
      expect(history.messages).toMatchObject([
        { id: one.id, content: '', deleted: true, attachments: [], reactions: [] },
        { id: two.id, content: '', deleted: true },
      ]);
      const row = await infra.db
        .selectFrom('messages')
        .select('deleted_at')
        .where('id', '=', one.id)
        .executeTakeFirstOrThrow();
      expect(row.deleted_at).not.toBeNull();
      expect(
        (
          await api(target, author)(`/api/messages/${one.id}`, {
            method: 'PATCH',
            body: { content: 'undead' },
          })
        ).status,
      ).toBe(404);
      expect(
        (await api(target, other)(`/api/messages/${one.id}/pin`, { method: 'PUT' })).status,
      ).toBe(404);
    });
  });

  describe('replies', () => {
    it('attaches a preview of the parent and tracks its deletion', async () => {
      const [author, replier] = [unique('author'), unique('replier')];
      const { channelId, post } = await setup(author, replier);
      const parent = await post(author, { content: 'x'.repeat(250) });
      const reply = await post(replier, { content: 'answer', replyToId: parent.id });

      expect(reply.replyTo).toEqual({
        id: parent.id,
        authorId: parent.author.id,
        contentPreview: 'x'.repeat(100),
        deleted: false,
      });
      await api(target, author)(`/api/messages/${parent.id}`, { method: 'DELETE' });
      const history = (await api(target, replier)(`/api/channels/${channelId}/messages`))
        .body as ListMessagesResponse;
      expect(history.messages.find((m) => m.id === reply.id)?.replyTo).toMatchObject({
        contentPreview: '',
        deleted: true,
      });
      const toDeleted = await api(target, replier)(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        body: { content: 'late', replyToId: parent.id },
      });
      expect(toDeleted.status).toBe(400);
    });

    it('rejects replies to messages in another channel or that do not exist', async () => {
      const user = unique('user');
      const { channelId, post } = await setup(user);
      const elsewhere = await setup(user);
      const foreign = await post(user, { content: 'here' });
      const send = (replyToId: string) =>
        api(target, user)(`/api/channels/${elsewhere.channelId}/messages`, {
          method: 'POST',
          body: { content: 'reply', replyToId },
        });
      expect((await send(foreign.id)).status).toBe(400);
      expect((await send('999999999')).status).toBe(400);
      expect(channelId).toBeTruthy();
    });
  });

  describe('reactions', () => {
    it('adds and removes reactions idempotently with events and counts', async () => {
      const [a, b] = [unique('a'), unique('b')];
      const { channelId, post } = await setup(a, b);
      const listener = await connect(b, channelId);
      const message = await post(a, { content: 'react to me' });
      const aId = message.author.id;
      const bId = await ensureUser(infra.db, b);

      expect(
        (
          await api(target, a)(`/api/messages/${message.id}/reactions/${THUMBS_UP}`, {
            method: 'PUT',
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await api(target, a)(`/api/messages/${message.id}/reactions/${THUMBS_UP}`, {
            method: 'PUT',
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await api(target, b)(`/api/messages/${message.id}/reactions/${THUMBS_UP}`, {
            method: 'PUT',
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await api(target, b)(
            `/api/messages/${message.id}/reactions/${encodeURIComponent(':party_parrot:')}`,
            { method: 'PUT' },
          )
        ).status,
      ).toBe(204);

      const added = await listener.waitFor('reaction.added', 3);
      expect(added.map((e) => [e.emoji, e.userId])).toEqual([
        ['👍', aId],
        ['👍', bId],
        [':party_parrot:', bId],
      ]);
      await settle();
      expect(listener.of('reaction.added')).toHaveLength(3);

      const history = (await api(target, a)(`/api/channels/${channelId}/messages`))
        .body as ListMessagesResponse;
      expect(history.messages[0]?.reactions).toEqual([
        { emoji: '👍', count: 2, userIds: [aId, bId] },
        { emoji: ':party_parrot:', count: 1, userIds: [bId] },
      ]);

      expect(
        (
          await api(target, a)(`/api/messages/${message.id}/reactions/${THUMBS_UP}`, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await api(target, a)(`/api/messages/${message.id}/reactions/${THUMBS_UP}`, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(204);
      const removed = await listener.waitFor('reaction.removed');
      expect(removed).toHaveLength(1);
      expect(removed[0]).toMatchObject({ messageId: message.id, emoji: '👍', userId: aId });
    });

    it('rejects anything that is not a single emoji or a shortcode', async () => {
      const user = unique('user');
      const { post } = await setup(user);
      const message = await post(user, { content: 'target' });
      for (const bad of [
        'a',
        'ab',
        '👍👍',
        '👍x',
        ':x:',
        ':UPPER:',
        ':has space:',
        '<script>',
        '12',
      ]) {
        const res = await api(target, user)(
          `/api/messages/${message.id}/reactions/${encodeURIComponent(bad)}`,
          { method: 'PUT' },
        );
        expect([bad, res.status]).toEqual([bad, 400]);
      }
      for (const good of ['👍', '🇩🇪', '👨‍👩‍👧', '🏳️‍🌈', '1️⃣', ':ok_2:']) {
        const res = await api(target, user)(
          `/api/messages/${message.id}/reactions/${encodeURIComponent(good)}`,
          { method: 'PUT' },
        );
        expect([good, res.status]).toEqual([good, 204]);
      }
    });

    it('caps a message at 20 distinct emoji but still allows joining existing ones', async () => {
      const [a, b] = [unique('a'), unique('b')];
      const { post } = await setup(a, b);
      const message = await post(a, { content: 'popular' });
      const emoji = Array.from({ length: 21 }, (_, i) => `:custom_${String(i).padStart(2, '0')}:`);
      const put = (who: string, e: string) =>
        api(target, who)(`/api/messages/${message.id}/reactions/${encodeURIComponent(e)}`, {
          method: 'PUT',
        });

      for (const e of emoji.slice(0, 20)) expect((await put(a, e)).status).toBe(204);
      const over = await put(a, emoji[20] ?? '');
      expect(over.status).toBe(400);
      expect(over.body).toMatchObject({ code: 'reaction_limit' });
      expect((await put(b, emoji[0] ?? '')).status).toBe(204);
    });

    it('lists at most 20 user ids per reaction while counting everyone', async () => {
      const author = unique('author');
      const { channelId, post } = await setup(author);
      const message = await post(author, { content: 'crowd' });
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) ids.push(await ensureUser(infra.db, unique(`fan${i}`)));
      await infra.db
        .insertInto('message_reactions')
        .values(ids.map((id) => ({ message_id: message.id, user_id: id, emoji: '🔥' })))
        .execute();
      const history = (await api(target, author)(`/api/channels/${channelId}/messages`))
        .body as ListMessagesResponse;
      const reaction = history.messages[0]?.reactions[0];
      expect(reaction?.count).toBe(25);
      expect(reaction?.userIds).toHaveLength(20);
    });

    it('rate limits reactions per user', async () => {
      const limited = await infra.startApp({ REACTION_RATE_MAX: '3', MESSAGE_RATE_MAX: '1000' });
      const user = unique('flood');
      const channelId = await createChannel(infra.db, [user]);
      const [id] = await insertMessages(infra.db, channelId, user, 1);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await api(limited, user)(
          `/api/messages/${id}/reactions/${encodeURIComponent(`:r_${i}x:`)}`,
          { method: 'PUT' },
        );
        statuses.push(res.status);
      }
      expect(statuses).toEqual([204, 204, 204, 429, 429]);
    });
  });

  describe('pins', () => {
    it('pins, lists and unpins with message.updated events', async () => {
      const [a, b] = [unique('a'), unique('b')];
      const { channelId, post } = await setup(a, b);
      const listener = await connect(b, channelId);
      const [one, two] = [await post(a, { content: 'one' }), await post(a, { content: 'two' })];

      const pinned = await api(target, b)(`/api/messages/${one.id}/pin`, { method: 'PUT' });
      expect(pinned.body).toMatchObject({ id: one.id, pinnedBy: await ensureUser(infra.db, b) });
      expect((pinned.body as Message).pinnedAt).not.toBeNull();
      await api(target, b)(`/api/messages/${one.id}/pin`, { method: 'PUT' });
      await api(target, a)(`/api/messages/${two.id}/pin`, { method: 'PUT' });
      await listener.waitFor('message.updated', 2);
      await settle();
      expect(listener.of('message.updated')).toHaveLength(2);

      const pins = (await api(target, a)(`/api/channels/${channelId}/pins`)).body as {
        messages: Message[];
      };
      expect(pins.messages.map((m) => m.id)).toEqual([two.id, one.id]);

      const unpinned = await api(target, a)(`/api/messages/${one.id}/pin`, { method: 'DELETE' });
      expect((unpinned.body as Message).pinnedAt).toBeNull();
      const after = (await api(target, a)(`/api/channels/${channelId}/pins`)).body as {
        messages: Message[];
      };
      expect(after.messages.map((m) => m.id)).toEqual([two.id]);
    });
  });

  describe('search', () => {
    it('finds messages by word and phrase, newest first, excluding deleted ones', async () => {
      const user = unique('searcher');
      const { channelId, post } = await setup(user);
      const first = await post(user, { content: 'The quick brown fox' });
      const second = await post(user, { content: 'quick thinking saves the day' });
      const gone = await post(user, { content: 'quick and deleted' });
      await post(user, { content: 'unrelated' });
      await api(target, user)(`/api/messages/${gone.id}`, { method: 'DELETE' });
      const search = async (query: string) =>
        (
          await api(
            target,
            user,
          )(`/api/search?channelId=${channelId}&q=${encodeURIComponent(query)}`)
        ).body as ListMessagesResponse;

      expect((await search('quick')).messages.map((m) => m.id)).toEqual([second.id, first.id]);
      expect((await search('"quick brown"')).messages.map((m) => m.id)).toEqual([first.id]);
      expect((await search('QUICK -brown')).messages.map((m) => m.id)).toEqual([second.id]);
      expect((await search('quick OR unrelated')).messages).toHaveLength(3);
      expect((await search('nothing-matches-this')).messages).toEqual([]);
    });

    it('only searches channels the caller belongs to', async () => {
      const [insider, outsider] = [unique('insider'), unique('outsider')];
      const word = `zebra${Date.now()}`;
      const { post } = await setup(insider);
      await post(insider, { content: `secret ${word}` });
      const mine = await setup(outsider);
      await mine.post(outsider, { content: `public ${word}` });

      const hits = (await api(target, outsider)(`/api/search?q=${word}`))
        .body as ListMessagesResponse;
      expect(hits.messages.map((m) => m.content)).toEqual([`public ${word}`]);
      const direct = await api(
        target,
        outsider,
      )(`/api/search?q=${word}&channelId=${(await setup(insider)).channelId}`);
      expect((direct.body as ListMessagesResponse).messages).toEqual([]);
    });

    it('paginates with a keyset cursor and validates input', async () => {
      const user = unique('pager');
      const { channelId, post } = await setup(user);
      const word = `pagination${Date.now()}`;
      for (let i = 0; i < 5; i++) await post(user, { content: `${word} ${i}` });
      const call = api(target, user);

      const page1 = (await call(`/api/search?q=${word}&channelId=${channelId}&limit=2`))
        .body as ListMessagesResponse;
      expect(page1.messages.map((m) => m.content)).toEqual([`${word} 4`, `${word} 3`]);
      expect(page1.hasMore).toBe(true);
      const cursor = page1.messages[1]?.id;
      const page2 = (
        await call(`/api/search?q=${word}&channelId=${channelId}&limit=2&before=${cursor}`)
      ).body as ListMessagesResponse;
      expect(page2.messages.map((m) => m.content)).toEqual([`${word} 2`, `${word} 1`]);
      const page3 = (
        await call(
          `/api/search?q=${word}&channelId=${channelId}&limit=2&before=${page2.messages[1]?.id}`,
        )
      ).body as ListMessagesResponse;
      expect(page3.messages.map((m) => m.content)).toEqual([`${word} 0`]);
      expect(page3.hasMore).toBe(false);

      expect((await call('/api/search')).status).toBe(400);
      expect((await call('/api/search?q=')).status).toBe(400);
      expect((await call('/api/search?q=x&limit=500')).status).toBe(400);
    });

    it('matches punctuation-heavy and non-English text with the simple config', async () => {
      const user = unique('polyglot');
      const { post } = await setup(user);
      const token = `ünïcödé${Date.now()}`;
      await post(user, { content: `running ${token} runs` });
      const hit = (await api(target, user)(`/api/search?q=${encodeURIComponent(token)}`))
        .body as ListMessagesResponse;
      expect(hit.messages).toHaveLength(1);
      const stem = (await api(target, user)('/api/search?q=run')).body as ListMessagesResponse;
      expect(stem.messages.some((m) => m.content.includes(token))).toBe(false);
    });
  });

  it('loads a history page in a constant number of queries', async () => {
    const queries: string[] = [];
    const counting = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: inject('databaseUrl'), max: 2 }),
      }),
      log: (event) => {
        if (event.level === 'query') queries.push(event.query.sql);
      },
    });
    const counted = await infra.startApp({ MESSAGE_RATE_MAX: '1000' }, counting);
    const user = unique('batch');
    const buddy = unique('buddy');
    const { channelId, post } = await setup(user, buddy);
    const uid = await ensureUser(infra.db, buddy);
    const history = async () => {
      queries.length = 0;
      const res = await api(counted, user)(`/api/channels/${channelId}/messages?limit=50`);
      return { page: res.body as ListMessagesResponse, used: queries.length };
    };

    const base = await post(user, { content: 'base' });
    await history(); // warms the user cache so auth queries are not counted
    const small = await history();
    for (let i = 0; i < 30; i++) {
      const m = await post(user, { content: `m${i} <@${uid}>`, replyToId: base.id });
      await api(target, user)(`/api/messages/${m.id}/reactions/${THUMBS_UP}`, { method: 'PUT' });
    }
    const large = await history();

    const replies = large.page.messages.filter((m) => m.replyTo?.id === base.id);
    expect(replies).toHaveLength(30);
    expect(replies.every((m) => m.reactions[0]?.count === 1 && m.mentions[0] === uid)).toBe(true);
    expect(large.used).toBe(small.used);
    await counting.destroy();
  });
});
