import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  createChannel,
  createGuild,
  createInfra,
  ensureUser,
  type Infra,
  type TestApp,
} from './support/harness.js';
import { addBotToGuild, botApi, createBot } from './support/bots.js';

const uid = () => randomUUID().slice(0, 8);
const ORIGIN = 'https://chat.example.ts.net:18470';

describe('bot-to-bot loop protection', () => {
  let infra: Infra;
  let app: TestApp;

  beforeAll(async () => {
    infra = createInfra();
    app = await infra.startApp({
      MESSAGE_RATE_MAX: '1000',
      BOT_MAX_HOPS: '4',
      BOT_BUDGET_MAX: '6',
    });
  });
  afterAll(async () => {
    await infra.stop();
  });

  async function world() {
    const tag = uid();
    const owner = `owner-${tag}@example.com`;
    await ensureUser(infra.db, owner);
    const guildId = await createGuild(infra.db, owner, []);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const scopes = ['messages.read', 'messages.write'];
    const a = await createBot(app, owner, { name: 'Alpha', scopes });
    const b = await createBot(app, owner, { name: 'Beta', scopes });
    await addBotToGuild(app, owner, guildId, a.bot.id);
    await addBotToGuild(app, owner, guildId, b.bot.id);
    return {
      owner,
      channelId,
      a: botApi(app, a.token),
      b: botApi(app, b.token),
      botBId: b.bot.id,
    };
  }

  const post = (
    as: ReturnType<typeof botApi>,
    channelId: string,
    content: string,
    replyToId?: string,
  ) =>
    as(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content, ...(replyToId && { replyToId }) },
    });

  it('refuses a reply chain between bots that is longer than BOT_MAX_HOPS', async () => {
    const w = await world();
    let last = (await post(w.a, w.channelId, 'start')).body as { id: string };
    const turns = [w.a, w.b];
    for (let hop = 1; hop <= 4; hop += 1) {
      const res = await post(turns[hop % 2] ?? w.a, w.channelId, `hop ${hop}`, last.id);
      expect(res.status).toBe(201);
      last = res.body as { id: string };
    }
    const refused = await post(turns[1] ?? w.b, w.channelId, 'hop 5', last.id);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'bot_loop' });
  });

  it('starts counting again when a person speaks, and does not count a bot answering itself', async () => {
    const w = await world();
    const first = (await post(w.a, w.channelId, 'one')).body as { id: string };
    const second = (await post(w.b, w.channelId, 'two', first.id)).body as { id: string };
    // A bot continuing its own thread does not lengthen the chain.
    for (let i = 0; i < 3; i += 1) {
      expect((await post(w.b, w.channelId, `more ${i}`, second.id)).status).toBe(201);
    }
    const human = await api(app, w.owner)(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: { content: 'carry on', replyToId: second.id },
    });
    expect(human.status).toBe(201);
    const humanId = (human.body as { id: string }).id;
    const afterHuman = await post(w.a, w.channelId, 'back to hop 0', humanId);
    expect(afterHuman.status).toBe(201);
    const next = await post(w.b, w.channelId, 'hop 1', (afterHuman.body as { id: string }).id);
    expect(next.status).toBe(201);
  });

  it('counts a mention of another bot as bot-to-bot traffic', async () => {
    const w = await world();
    const res = await post(w.a, w.channelId, `hey <@${w.botBId}>`);
    expect(res.status).toBe(201);
  });

  it('caps bot-to-bot messages per channel per window with bot_budget', async () => {
    const w = await world();
    const opener = (await post(w.a, w.channelId, 'budget')).body as { id: string };
    let refused: { status: number; body: unknown } | undefined;
    for (let i = 0; i < 12 && !refused; i += 1) {
      const res = await post(w.b, w.channelId, `reply ${i}`, opener.id);
      if (res.status === 429) refused = res;
      else expect(res.status).toBe(201);
    }
    expect(refused?.body).toMatchObject({ code: 'bot_budget' });
    // People are not affected.
    const human = await api(app, w.owner)(`/api/channels/${w.channelId}/messages`, {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: { content: 'still fine' },
    });
    expect(human.status).toBe(201);
  });
});
