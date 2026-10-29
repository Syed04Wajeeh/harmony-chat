import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HarmonyClient, HarmonyError } from '../src/client.js';
import { ADA, BOT, FakeHarmony, TOKEN } from './fake-harmony.js';

describe('HarmonyClient.waitForMessage', () => {
  let fake: FakeHarmony;
  let client: HarmonyClient;

  beforeAll(async () => {
    fake = await FakeHarmony.start();
    client = new HarmonyClient({ url: fake.url, token: TOKEN });
  });
  afterAll(async () => {
    await fake.stop();
  });
  afterEach(() => {
    fake.refuseWebSocket = false;
    fake.messages.clear();
  });

  const humans = (m: { author: { isBot?: boolean | undefined } }) => !m.author.isBot;

  async function socketReady(count = 1): Promise<void> {
    const deadline = Date.now() + 3000;
    while (fake.socketCount < count) {
      if (Date.now() > deadline) throw new Error('no socket');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('derives the bot id from the token', () => {
    expect(client.botId).toBe('900');
    expect(() => new HarmonyClient({ url: fake.url, token: 'nope' })).toThrow(
      'Not a Harmony bot token',
    );
  });

  it('reconnects after the socket drops and loses nothing sent in between', async () => {
    const start = fake.post('11', BOT, 'start');
    const waiting = client.waitForMessage({
      channelId: '11',
      afterMessageId: start.id,
      timeoutMs: 8000,
      accept: humans,
      reconnectBaseMs: 20,
    });
    await socketReady();
    fake.dropSockets();
    // Arrives while no socket is connected; the resubscribe backfills it.
    const missed = fake.postQuietly('11', ADA, 'during the gap');
    const result = await waiting;
    expect(result.message?.id).toBe(missed.id);
    expect(result.reconnects).toBeGreaterThanOrEqual(1);
    expect(result.transport).toBe('websocket');
  });

  it('falls back to polling REST when the gateway keeps failing', async () => {
    fake.refuseWebSocket = true;
    const start = fake.post('11', BOT, 'start');
    const waiting = client.waitForMessage({
      channelId: '11',
      afterMessageId: start.id,
      timeoutMs: 8000,
      accept: humans,
      reconnectBaseMs: 10,
      pollIntervalMs: 30,
      maxSocketFailures: 2,
    });
    setTimeout(() => fake.post('11', ADA, 'polled answer'), 400);
    const result = await waiting;
    expect(result.message?.content).toBe('polled answer');
    expect(result.transport).toBe('polling');
  });

  it('defaults the cursor to the newest message so old messages never match', async () => {
    fake.post('11', ADA, 'old news');
    const result = await client.waitForMessage({
      channelId: '11',
      timeoutMs: 400,
      accept: humans,
    });
    expect(result.message).toBeNull();
  });

  it('stops early when cancelled', async () => {
    const controller = new AbortController();
    const waiting = client.waitForMessage({
      channelId: '11',
      afterMessageId: '1',
      timeoutMs: 30_000,
      accept: () => false,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await waiting;
    expect(result).toMatchObject({ message: null, cancelled: true });
  });

  it('throws a typed error for a channel the bot cannot subscribe to', async () => {
    await expect(
      client.waitForMessage({
        channelId: '999',
        afterMessageId: '1',
        timeoutMs: 2000,
        accept: () => true,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('HarmonyClient REST', () => {
  it('turns error bodies into HarmonyError', async () => {
    const fake = await FakeHarmony.start();
    const client = new HarmonyClient({ url: fake.url, token: TOKEN });
    fake.failures.push({
      match: 'GET /api/guilds',
      status: 403,
      code: 'missing_scope',
      message: 'nope',
    });
    await expect(client.listGuilds()).rejects.toMatchObject({ status: 403, code: 'missing_scope' });
    await expect(client.listGuilds()).resolves.toHaveLength(2);
    await expect(client.getMessages('424242')).rejects.toBeInstanceOf(HarmonyError);
    await fake.stop();
  });
});
