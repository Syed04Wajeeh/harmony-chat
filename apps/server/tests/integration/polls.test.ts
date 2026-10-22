import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ListMessagesResponse, Message, Poll } from '@harmony/shared';
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

const uid = () => randomUUID().slice(0, 8);

describe('polls', () => {
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

  async function world() {
    const owner = `owner-${uid()}@example.com`;
    const alice = `alice-${uid()}@example.com`;
    const bob = `bob-${uid()}@example.com`;
    await ensureUser(infra.db, owner);
    const guildId = await createGuild(infra.db, owner, [alice, bob]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const as = (login: string) => api(target, login);
    const create = (login: string, body: object, at = target) =>
      api(at, login)(`/api/channels/${channelId}/polls`, { method: 'POST', body });
    const vote = (login: string, messageId: string, optionIds: number[], at = target) =>
      api(at, login)(`/api/polls/${messageId}/votes`, { method: 'PUT', body: { optionIds } });
    const connect = async (login: string, at = target) => {
      const socket = await TestSocket.connect(at, login);
      sockets.push(socket);
      await socket.subscribe(channelId);
      return socket;
    };
    const history = async (login: string) =>
      ((await as(login)(`/api/channels/${channelId}/messages`)).body as ListMessagesResponse)
        .messages;
    return { owner, alice, bob, guildId, channelId, as, create, vote, connect, history };
  }

  const poll = (message: Message) => message.modules?.['polls'] as Poll;
  const question = { question: 'Where to eat?', options: ['Pizza', 'Ramen', 'Tacos'] };

  describe('creating', () => {
    it('posts the question as a message that carries the poll', async () => {
      const w = await world();
      const live = await w.connect(w.bob);
      const res = await w.create(w.alice, question);
      expect(res.status).toBe(201);
      const message = res.body as Message;
      expect(message.content).toBe('Where to eat?');
      expect(message.author.login).toBe(w.alice);
      expect(poll(message)).toMatchObject({
        multiple: false,
        closed: false,
        totalVoters: 0,
        options: [
          { id: 1, label: 'Pizza', votes: 0, voterIds: [] },
          { id: 2, label: 'Ramen', votes: 0, voterIds: [] },
          { id: 3, label: 'Tacos', votes: 0, voterIds: [] },
        ],
      });
      const [seen] = await live.waitFor('message.created');
      expect(seen?.message).toEqual(message);
    });

    it('validates the question and options', async () => {
      const w = await world();
      const bad = (body: object) => w.create(w.alice, body);
      expect((await bad({ ...question, options: ['only one'] })).status).toBe(400);
      expect(
        (await bad({ ...question, options: Array.from({ length: 11 }, (_, i) => `o${String(i)}`) }))
          .status,
      ).toBe(400);
      expect((await bad({ ...question, options: ['Same', 'same'] })).status).toBe(400);
      expect((await bad({ ...question, question: '  ' })).status).toBe(400);
      expect((await bad({ ...question, options: ['a', ' '] })).status).toBe(400);
    });

    it('needs membership of the channel', async () => {
      const w = await world();
      const outsider = `outsider-${uid()}@example.com`;
      await ensureUser(infra.db, outsider);
      expect((await w.create(outsider, question)).status).toBe(403);
    });

    it('honours the guild setting for multiple choice', async () => {
      const w = await world();
      expect((await w.create(w.alice, { ...question, multiple: true })).status).toBe(201);
      const off = await w.as(w.owner)(`/api/guilds/${w.guildId}/modules/polls`, {
        method: 'PUT',
        body: { settings: { allowMultipleChoice: false } },
      });
      expect(off.status).toBe(200);
      const refused = await w.create(w.alice, { ...question, multiple: true });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: 'multiple_choice_disabled' });
      expect((await w.create(w.alice, question)).status).toBe(201);
    });

    it('works in a DM, where there is no guild to configure it', async () => {
      const w = await world();
      const dm = await w.as(w.alice)('/api/dms', {
        method: 'POST',
        body: { userId: await ensureUser(infra.db, w.bob) },
      });
      const res = await api(target, w.alice)(
        `/api/channels/${(dm.body as { id: string }).id}/polls`,
        {
          method: 'POST',
          body: question,
        },
      );
      expect(res.status).toBe(201);
    });

    it('is open to bots with the messages.write scope', async () => {
      const w = await world();
      const bot = await createBot(target, w.owner, { scopes: ['messages.read', 'messages.write'] });
      await addBotToGuild(target, w.owner, w.guildId, bot.bot.id);
      await infra.db
        .insertInto('channel_members')
        .values({ channel_id: w.channelId, user_id: bot.bot.id, last_read_message_id: null })
        .onConflict((oc) => oc.doNothing())
        .execute();
      const asBot = botApi(target, bot.token);
      const res = await asBot(`/api/channels/${w.channelId}/polls`, {
        method: 'POST',
        body: question,
      });
      expect(res.status).toBe(201);
      const message = res.body as Message;
      expect(message.author.id).toBe(bot.bot.id);

      const readOnly = await createBot(target, w.owner, { scopes: ['messages.read'] });
      const denied = await botApi(target, readOnly.token)(`/api/channels/${w.channelId}/polls`, {
        method: 'POST',
        body: question,
      });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'missing_scope' });
    });

    it('is also what /poll does, with options split on |', async () => {
      const w = await world();
      const live = await w.connect(w.bob);
      const res = await w.as(w.alice)(`/api/channels/${w.channelId}/commands`, {
        method: 'POST',
        body: {
          name: 'poll',
          options: { question: 'Tea or coffee?', options: 'tea | coffee | water', multiple: true },
        },
      });
      expect(res.status).toBe(202);
      const [created] = await live.waitFor('message.created');
      expect(created?.message.content).toBe('Tea or coffee?');
      expect(poll(created?.message as Message)).toMatchObject({ multiple: true });
      expect(poll(created?.message as Message).options.map((o) => o.label)).toEqual([
        'tea',
        'coffee',
        'water',
      ]);

      const tooFew = await w.as(w.alice)(`/api/channels/${w.channelId}/commands`, {
        method: 'POST',
        body: { name: 'poll', options: { question: 'Hm?', options: 'just one' } },
      });
      expect(tooFew.status).toBe(400);
      expect(tooFew.body).toMatchObject({ code: 'invalid_poll' });
    });
  });

  describe('voting', () => {
    it('counts votes, shows who voted, and reaches everyone in the channel live', async () => {
      const w = await world();
      const message = (await w.create(w.alice, question)).body as Message;
      const live = await w.connect(w.bob);

      const res = await w.vote(w.bob, message.id, [2]);
      expect(res.status).toBe(200);
      const bobId = await ensureUser(infra.db, w.bob);
      expect(res.body).toMatchObject({
        totalVoters: 1,
        options: [
          { id: 1, votes: 0 },
          { id: 2, votes: 1, voterIds: [bobId] },
          { id: 3, votes: 0 },
        ],
      });
      const [frame] = await live.waitForModule('polls.updated');
      expect(frame).toMatchObject({ channelId: w.channelId, messageId: message.id });
      expect((frame as unknown as { poll: Poll }).poll.totalVoters).toBe(1);
    });

    it('lets a single-choice voter change their mind, and retract', async () => {
      const w = await world();
      const message = (await w.create(w.alice, question)).body as Message;
      await w.vote(w.bob, message.id, [1]);
      const switched = (await w.vote(w.bob, message.id, [3])).body as Poll;
      expect(switched.options.map((o) => o.votes)).toEqual([0, 0, 1]);
      expect(switched.totalVoters).toBe(1);
      const retracted = (await w.vote(w.bob, message.id, [])).body as Poll;
      expect(retracted.options.map((o) => o.votes)).toEqual([0, 0, 0]);
      expect(retracted.totalVoters).toBe(0);
    });

    it('allows one choice unless the poll is multiple choice', async () => {
      const w = await world();
      const single = (await w.create(w.alice, question)).body as Message;
      const tooMany = await w.vote(w.bob, single.id, [1, 2]);
      expect(tooMany.status).toBe(400);
      expect(tooMany.body).toMatchObject({ code: 'single_choice' });

      const multi = (await w.create(w.alice, { ...question, multiple: true })).body as Message;
      const both = (await w.vote(w.bob, multi.id, [1, 3])).body as Poll;
      expect(both.options.map((o) => o.votes)).toEqual([1, 0, 1]);
      expect(both.totalVoters).toBe(1);
      const other = (await w.vote(w.alice, multi.id, [1])).body as Poll;
      expect(other.options.map((o) => o.votes)).toEqual([2, 0, 1]);
      expect(other.totalVoters).toBe(2);
    });

    it('rejects options that do not exist, strangers, and non-polls', async () => {
      const w = await world();
      const message = (await w.create(w.alice, question)).body as Message;
      const invalid = await w.vote(w.bob, message.id, [9]);
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({ code: 'invalid_option' });

      const outsider = `outsider-${uid()}@example.com`;
      await ensureUser(infra.db, outsider);
      expect((await w.vote(outsider, message.id, [1])).status).toBe(403);

      const plain = (
        await w.as(w.alice)(`/api/channels/${w.channelId}/messages`, {
          method: 'POST',
          body: { content: 'not a poll' },
        })
      ).body as Message;
      const none = await w.vote(w.bob, plain.id, [1]);
      expect(none.status).toBe(404);
      expect(none.body).toMatchObject({ code: 'poll_not_found' });
    });

    it('survives two people voting at once', async () => {
      const w = await world();
      const message = (await w.create(w.alice, question)).body as Message;
      await Promise.all([
        w.vote(w.alice, message.id, [1]),
        w.vote(w.bob, message.id, [1]),
        w.vote(w.owner, message.id, [2]),
        w.vote(w.bob, message.id, [3]),
      ]);
      const final = (await w.as(w.alice)(`/api/polls/${message.id}`)).body as Poll;
      const perVoter = new Map<string, number>();
      for (const option of final.options) {
        for (const voter of option.voterIds) perVoter.set(voter, (perVoter.get(voter) ?? 0) + 1);
      }
      expect([...perVoter.values()].every((n) => n === 1)).toBe(true);
      expect(final.totalVoters).toBe(3);
    });

    it('has a WebSocket twin that behaves the same', async () => {
      const w = await world();
      const message = (await w.create(w.alice, question)).body as Message;
      const voter = await w.connect(w.bob);
      const watcher = await w.connect(w.alice);
      voter.send({ type: 'polls.vote', messageId: message.id, optionIds: [3] });
      const [frame] = await watcher.waitForModule('polls.updated');
      expect((frame as unknown as { poll: Poll }).poll.options.map((o) => o.votes)).toEqual([
        0, 0, 1,
      ]);

      voter.send({ type: 'polls.vote', messageId: message.id, optionIds: [1, 2] });
      expect((await voter.waitFor('error'))[0]?.code).toBe('single_choice');
    });

    it('is rate limited', async () => {
      const limited = await infra.startApp({ POLLS_VOTE_RATE_MAX: '2' });
      const w = await world();
      const message = (await w.create(w.alice, question, limited)).body as Message;
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++)
        statuses.push((await w.vote(w.bob, message.id, [1], limited)).status);
      expect(statuses).toEqual([200, 200, 429, 429]);
    });
  });

  describe('closing', () => {
    it('is the author’s to do, ends voting, and is announced', async () => {
      const w = await world();
      const message = (await w.create(w.alice, question)).body as Message;
      await w.vote(w.bob, message.id, [1]);
      const live = await w.connect(w.bob);

      const byOther = await w.as(w.bob)(`/api/polls/${message.id}/close`, { method: 'POST' });
      expect(byOther.status).toBe(403);

      const closed = await w.as(w.alice)(`/api/polls/${message.id}/close`, { method: 'POST' });
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ closed: true, totalVoters: 1 });
      expect((closed.body as Poll).closedAt).toEqual(expect.any(String));
      const [frame] = await live.waitForModule('polls.updated');
      expect((frame as unknown as { poll: Poll }).poll.closed).toBe(true);

      const late = await w.vote(w.bob, message.id, [2]);
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({ code: 'poll_closed' });
      const again = await w.as(w.alice)(`/api/polls/${message.id}/close`, { method: 'POST' });
      expect(again.status).toBe(200);
      await settle();
      expect(live.ofModule('polls.updated')).toHaveLength(1);
    });
  });

  describe('reading', () => {
    it('adds the tallies to history, in batches, and only to poll messages', async () => {
      const w = await world();
      const first = (await w.create(w.alice, question)).body as Message;
      const second = (await w.create(w.bob, { ...question, question: 'Second?' })).body as Message;
      await w.as(w.alice)(`/api/channels/${w.channelId}/messages`, {
        method: 'POST',
        body: { content: 'plain' },
      });
      await w.vote(w.bob, first.id, [2]);
      await w.vote(w.alice, second.id, [1]);

      const messages = await w.history(w.owner);
      const plain = messages.find((m) => m.content === 'plain');
      expect(plain?.modules).toBeUndefined();
      expect(poll(messages.find((m) => m.id === first.id) as Message).options[1]?.votes).toBe(1);
      expect(poll(messages.find((m) => m.id === second.id) as Message).options[0]?.votes).toBe(1);
    });

    it('also decorates backfill and search results', async () => {
      const w = await world();
      const message = (await w.create(w.alice, { ...question, question: `zebra${uid()}` }))
        .body as Message;
      await w.vote(w.bob, message.id, [1]);
      const socket = await TestSocket.connect(target, w.owner);
      sockets.push(socket);
      await socket.subscribe(w.channelId, '0');
      const backfilled = socket
        .of('backfill')
        .at(-1)
        ?.messages.find((m) => m.id === message.id);
      expect(poll(backfilled as Message).totalVoters).toBe(1);

      const found = (await w.as(w.owner)(`/api/search?q=${encodeURIComponent(message.content)}`))
        .body as ListMessagesResponse;
      expect(poll(found.messages[0] as Message).totalVoters).toBe(1);
    });

    it('serves a single poll to members', async () => {
      const w = await world();
      const message = (await w.create(w.alice, question)).body as Message;
      const res = await w.as(w.bob)(`/api/polls/${message.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ closed: false });
    });

    it('drops the tallies of a deleted poll', async () => {
      const w = await world();
      const message = (await w.create(w.alice, question)).body as Message;
      await w.as(w.alice)(`/api/messages/${message.id}`, { method: 'DELETE' });
      const stored = (await w.history(w.bob)).find((m) => m.id === message.id);
      expect(stored?.deleted).toBe(true);
      expect(stored?.modules).toBeUndefined();
      expect((await w.vote(w.bob, message.id, [1])).status).toBe(404);
    });
  });

  describe('switched off in a guild', () => {
    it('stops creating and voting there, and says so', async () => {
      const w = await world();
      const message = (await w.create(w.alice, question)).body as Message;
      await w.as(w.owner)(`/api/guilds/${w.guildId}/modules/polls`, {
        method: 'PUT',
        body: { enabled: false },
      });
      const create = await w.create(w.alice, question);
      expect(create.status).toBe(404);
      expect(create.body).toMatchObject({ code: 'module_disabled' });
      expect((await w.vote(w.bob, message.id, [1])).body).toMatchObject({
        code: 'module_disabled',
      });
      const command = await w.as(w.alice)(`/api/channels/${w.channelId}/commands`, {
        method: 'POST',
        body: { name: 'poll', options: { question: 'q', options: 'a|b' } },
      });
      expect(command.status).toBe(404);
    });
  });

  describe('two instances', () => {
    it('show a vote cast on one to a client connected to the other', async () => {
      const second = await infra.startApp({ MESSAGE_RATE_MAX: '1000' });
      expect(second.config.INSTANCE_ID).not.toBe(target.config.INSTANCE_ID);
      const w = await world();
      const message = (await w.create(w.alice, question)).body as Message;
      const watcher = await w.connect(w.alice, second);

      await w.vote(w.bob, message.id, [2], target);
      const [first] = await watcher.waitForModule('polls.updated');
      expect((first as unknown as { poll: Poll }).poll.options.map((o) => o.votes)).toEqual([
        0, 1, 0,
      ]);

      await w.vote(w.owner, message.id, [2], second);
      const frames = await watcher.waitForModule('polls.updated', 2);
      expect((frames[1] as unknown as { poll: Poll }).poll.totalVoters).toBe(2);
    });
  });
});
