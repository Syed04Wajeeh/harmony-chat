import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message } from '@harmony/shared';
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
import { bare } from './support/bots.js';
import { kumaDown, kumaTest, kumaUp } from '../support/kuma-payloads.js';

const uid = () => randomUUID().slice(0, 8);

describe('incoming webhooks', () => {
  let infra: Infra;
  let target: TestApp;

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ WEBHOOK_RATE_MAX: '5', LOG_LEVEL: 'error' });
  });
  afterAll(() => infra.stop());

  async function setup() {
    const owner = `owner-${uid()}@example.com`;
    const member = `member-${uid()}@example.com`;
    const guildId = await createGuild(infra.db, owner, [member]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const created = await api(target, owner)(`/api/channels/${channelId}/webhooks`, {
      method: 'POST',
      body: { name: 'CI Bot' },
    });
    expect(created.status).toBe(201);
    const hook = created.body as { id: string; url: string; name: string };
    return { owner, member, guildId, channelId, hook, url: hook.url };
  }

  it('creates a webhook, showing its URL once', async () => {
    const w = await setup();
    expect(w.url).toMatch(new RegExp(`^/api/webhooks/${w.hook.id}/[A-Za-z0-9_-]{43}$`));

    const listed = await api(target, w.owner)(`/api/channels/${w.channelId}/webhooks`);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ webhooks: [{ id: w.hook.id, name: 'CI Bot' }] });
    expect(JSON.stringify(listed.body)).not.toContain(w.url.split('/').pop());

    const row = await infra.db
      .selectFrom('webhooks')
      .innerJoin('users', 'users.id', 'webhooks.user_id')
      .select(['webhooks.token_hash', 'users.kind', 'users.login'])
      .where('webhooks.id', '=', w.hook.id)
      .executeTakeFirstOrThrow();
    expect(row.token_hash).toHaveLength(32);
    expect(row.kind).toBe('bot');
    expect(row.login).toMatch(/^webhook-\d+@bots\.harmony\.invalid$/);
  });

  it('lets only guild owners and instance admins manage webhooks', async () => {
    const w = await setup();
    const asMember = api(target, w.member);
    const denied = await asMember(`/api/channels/${w.channelId}/webhooks`, {
      method: 'POST',
      body: { name: 'sneaky' },
    });
    expect(denied.status).toBe(403);
    expect((await asMember(`/api/channels/${w.channelId}/webhooks`)).status).toBe(403);
    expect((await asMember(`/api/webhooks/${w.hook.id}`, { method: 'DELETE' })).status).toBe(403);

    const admin = `admin-${uid()}@example.com`;
    await ensureUser(infra.db, admin, { admin: true });
    // Instance admins still have to be able to see the channel.
    expect((await api(target, admin)(`/api/channels/${w.channelId}/webhooks`)).status).toBe(403);
    await infra.db
      .insertInto('guild_members')
      .values({ guild_id: w.guildId, user_id: await ensureUser(infra.db, admin) })
      .execute();
    await infra.db
      .insertInto('channel_members')
      .values({
        channel_id: w.channelId,
        user_id: await ensureUser(infra.db, admin),
        last_read_message_id: null,
      })
      .execute();
    expect((await api(target, admin)(`/api/channels/${w.channelId}/webhooks`)).status).toBe(200);
  });

  it('posts a Discord-style message with embeds, overrides and a mention, with no other auth', async () => {
    const w = await setup();
    const mentionId = await ensureUser(infra.db, w.owner);
    const res = await bare(target, `${w.url}?wait=true`, {
      body: {
        content: `deploy done <@${mentionId}> @everyone`,
        username: 'Deployer',
        avatar_url: 'https://example.com/deploy.png',
        embeds: [
          {
            title: 'Build 42',
            color: 0x00ff00,
            fields: [{ name: 'Branch', value: 'main', inline: true }],
            footer: { text: 'ci' },
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const message = res.body as Message;
    expect(message).toMatchObject({
      channelId: w.channelId,
      displayNameOverride: 'Deployer',
      avatarUrlOverride: 'https://example.com/deploy.png',
      webhookId: w.hook.id,
      author: { isBot: true, displayName: 'CI Bot' },
      mentions: [mentionId],
    });
    expect(message.content).not.toMatch(/@everyone/);
    expect(message.embeds?.[0]).toMatchObject({ title: 'Build 42', color: 0x00ff00 });

    const history = await api(target, w.owner)(`/api/channels/${w.channelId}/messages`);
    const stored = (history.body as { messages: Message[] }).messages.find(
      (m) => m.id === message.id,
    );
    expect(stored?.embeds?.[0]?.fields).toEqual([{ name: 'Branch', value: 'main', inline: true }]);
    expect(stored?.displayNameOverride).toBe('Deployer');
  });

  it('answers 204 without ?wait=true and accepts Slack text', async () => {
    const w = await setup();
    const slack = await bare(target, w.url, { body: { text: 'plain slack text' } });
    expect(slack.status).toBe(204);
    const history = await api(target, w.owner)(`/api/channels/${w.channelId}/messages`);
    expect((history.body as { messages: Message[] }).messages.map((m) => m.content)).toContain(
      'plain slack text',
    );
  });

  it('allows empty content when there are embeds and rejects empty payloads', async () => {
    const w = await setup();
    const embedOnly = await bare(target, `${w.url}?wait=true`, {
      body: { embeds: [{ description: 'just an embed' }] },
    });
    expect(embedOnly.status).toBe(200);
    expect((embedOnly.body as Message).content).toBe('');
    expect((await bare(target, w.url, { body: {} })).status).toBe(400);
    expect((await bare(target, w.url, { body: { content: 'x'.repeat(2001) } })).status).toBe(400);
    expect(
      (
        await bare(target, w.url, {
          body: { embeds: Array.from({ length: 11 }, () => ({ title: 't' })) },
        })
      ).status,
    ).toBe(400);
  });

  it('delivers webhook messages live to channel subscribers', async () => {
    const w = await setup();
    const socket = await TestSocket.connect(target, w.owner);
    await socket.subscribe(w.channelId);
    await bare(target, w.url, { body: { content: 'live', username: 'Live' } });
    const [created] = await socket.waitFor('message.created');
    expect(created?.message).toMatchObject({ content: 'live', displayNameOverride: 'Live' });
    await socket.close();
  });

  it('accepts Uptime Kuma payloads, down and up', async () => {
    const w = await setup();
    for (const [name, payload] of [
      ['down', kumaDown],
      ['up', kumaUp],
      ['test', kumaTest],
    ] as const) {
      const res = await bare(target, `${w.url}?wait=true`, { body: payload });
      expect(res.status, name).toBe(200);
    }
    const history = await api(target, w.owner)(`/api/channels/${w.channelId}/messages`);
    const messages = (history.body as { messages: Message[] }).messages;
    const down = messages.find((m) => m.embeds?.[0]?.title?.includes('went down'));
    expect(down?.embeds?.[0]).toMatchObject({
      color: 16711680,
      timestamp: '2026-10-22T08:15:30.123Z',
    });
    expect(down?.embeds?.[0]?.fields?.map((f) => f.name)).toEqual([
      'Service Name',
      'Service URL',
      'Went Offline',
      'Time (UTC)',
      'Error',
    ]);
    expect(down?.displayNameOverride).toBe('Uptime Kuma');
    expect(down?.content).not.toMatch(/@everyone/i);
    const up = messages.find((m) => m.embeds?.[0]?.title?.includes('is up'));
    expect(up?.embeds?.[0]).toMatchObject({ color: 65280 });
    expect(messages.some((m) => m.content === 'Sent from Uptime Kuma')).toBe(true);
  });

  it('rejects a wrong token and an unknown webhook the same way', async () => {
    const w = await setup();
    const wrong = await bare(target, `/api/webhooks/${w.hook.id}/${'A'.repeat(43)}`, {
      body: { content: 'x' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ code: 'invalid_token' });
    const unknown = await bare(target, `/api/webhooks/999999999/${'A'.repeat(43)}`, {
      body: { content: 'x' },
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    const truncated = await bare(target, w.url.slice(0, -1), { body: { content: 'x' } });
    expect(truncated.status).toBe(401);
  });

  it('ignores identity headers: the path token is the only credential', async () => {
    const w = await setup();
    const res = await bare(target, `${w.url}?wait=true`, {
      body: { content: 'sent with forged headers' },
      headers: {
        'tailscale-user-login': w.owner,
        'x-harmony-proxy-secret': 'nope',
        origin: 'https://evil.example',
      },
    });
    expect(res.status).toBe(200);
    expect((res.body as Message).author.isBot).toBe(true);
  });

  it('rate-limits per webhook with Retry-After, leaving other webhooks alone', async () => {
    const w = await setup();
    const other = await setup();
    const statuses: number[] = [];
    let limited: Awaited<ReturnType<typeof bare>> | undefined;
    for (let i = 0; i < 7; i++) {
      const res = await bare(target, w.url, { body: { content: `n${i}` } });
      statuses.push(res.status);
      if (res.status === 429) limited ??= res;
    }
    expect(statuses).toEqual([204, 204, 204, 204, 204, 429, 429]);
    expect(limited?.body).toMatchObject({ code: 'rate_limited' });
    expect(Number(limited?.headers['retry-after'])).toBeGreaterThan(0);
    expect((await bare(target, other.url, { body: { content: 'fine' } })).status).toBe(204);
  });

  it('stops working once deleted, but keeps its messages', async () => {
    const w = await setup();
    await bare(target, w.url, { body: { content: 'keep me' } });
    expect(
      (await api(target, w.owner)(`/api/webhooks/${w.hook.id}`, { method: 'DELETE' })).status,
    ).toBe(204);
    expect((await bare(target, w.url, { body: { content: 'again' } })).status).toBe(401);
    const history = await api(target, w.owner)(`/api/channels/${w.channelId}/messages`);
    expect((history.body as { messages: Message[] }).messages.map((m) => m.content)).toContain(
      'keep me',
    );
  });

  it('refuses webhooks in DMs', async () => {
    const a = `a-${uid()}@example.com`;
    const b = `b-${uid()}@example.com`;
    const guildId = await createGuild(infra.db, a, [b]);
    await createChannel(infra.db, [a], { guildId, createdBy: a });
    const dm = await api(target, a)('/api/dms', {
      method: 'POST',
      body: { userId: await ensureUser(infra.db, b) },
    });
    const channelId = (dm.body as { id: string }).id;
    const res = await api(target, a)(`/api/channels/${channelId}/webhooks`, {
      method: 'POST',
      body: { name: 'x' },
    });
    expect(res.status).toBe(400);
  });

  it('writes the webhook message to the outbox like any other', async () => {
    const w = await setup();
    const res = await bare(target, `${w.url}?wait=true`, { body: { content: 'outbox me' } });
    const id = (res.body as Message).id;
    const event = await infra.db
      .selectFrom('event_outbox')
      .selectAll()
      .where('type', '=', 'message.created')
      .where('channel_id', '=', w.channelId)
      .executeTakeFirstOrThrow();
    expect((event.payload as { message: Message }).message.id).toBe(id);
  });
});
