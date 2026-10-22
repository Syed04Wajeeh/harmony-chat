import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { addBotToGuild, createBot } from './support/bots.js';

const BOT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../examples/echo-bot/bot.ts',
);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('examples/echo-bot', () => {
  let infra: Infra;
  let target: TestApp;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ OUTBOUND_PRIVATE_ALLOWLIST: '127.0.0.1' });
  });
  afterAll(async () => {
    child?.kill();
    await infra.stop();
  });

  it('registers its commands, answers /echo ephemerally and /roll with a follow-up', async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = `owner-${tag}@example.com`;
    const user = `user-${tag}@example.com`;
    await ensureUser(infra.db, owner, { admin: true });
    const guildId = await createGuild(infra.db, owner, [user]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const port = await freePort();
    const created = await createBot(target, owner, {
      scopes: ['messages.read', 'messages.write', 'commands', 'events'],
      interactionsUrl: `http://127.0.0.1:${port}/interactions`,
      eventsUrl: `http://127.0.0.1:${port}/events`,
    });
    await addBotToGuild(target, owner, guildId, created.bot.id);

    child = spawn('node', [BOT_FILE], {
      env: {
        ...process.env,
        PORT: String(port),
        HARMONY_URL: target.url,
        HARMONY_BOT_TOKEN: created.token,
        HARMONY_SIGNING_SECRET: created.signingSecret,
        HARMONY_GUILD_ID: guildId,
      },
      stdio: 'ignore',
    });

    const asUser = api(target, user);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const listed = await asUser(`/api/guilds/${guildId}/commands`);
      const commands = (listed.body as { commands: { botId: string | null }[] }).commands;
      if (commands.filter((command) => command.botId !== null).length === 2) break;
      if (Date.now() > deadline) throw new Error('bot never registered its commands');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const socket = await TestSocket.connect(target, user);
    await socket.subscribe(channelId);
    await asUser(`/api/channels/${channelId}/commands`, {
      method: 'POST',
      body: { name: 'echo', options: { text: 'hello example' } },
    });
    const [ephemeral] = await socket.waitFor('interaction.ephemeral');
    expect(ephemeral?.content).toBe('hello example');

    await asUser(`/api/channels/${channelId}/commands`, {
      method: 'POST',
      body: { name: 'roll', options: { sides: 6 } },
    });
    await socket.waitFor('interaction.pending');
    const [message] = await socket.waitFor('message.created');
    expect(message?.message.content).toMatch(/^You rolled a [1-6]$/);
    expect(message?.message.author.id).toBe(created.bot.id);
    await socket.close();
  });
});
