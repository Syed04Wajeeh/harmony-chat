import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { addBotToGuild, createBot } from './support/bots.js';

const MCP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/mcp',
);

interface Line {
  tool: string;
  isError: boolean;
  text: string;
  data?: Record<string, unknown>;
}

/** packages/mcp over stdio, against the real app: ask_human sends a question and gets a person's answer. */
describe('packages/mcp', () => {
  let infra: Infra;
  let target: TestApp;

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@harmony/mcp', 'build'], { encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`mcp build failed: ${build.stdout}${build.stderr}`);
    infra = createInfra();
    target = await infra.startApp();
  });
  afterAll(async () => {
    await infra.stop();
  });

  it('sends a question as the bot and returns the human reply it receives over the gateway', async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = `owner-${tag}@example.com`;
    const user = `user-${tag}@example.com`;
    await ensureUser(infra.db, owner);
    const guildId = await createGuild(infra.db, owner, [user]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const created = await createBot(target, owner, {
      scopes: ['messages.read', 'messages.write', 'channels.read'],
    });
    await addBotToGuild(target, owner, guildId, created.bot.id);

    const child = spawn(
      process.execPath,
      [path.join(MCP_DIR, 'tests/stdio-driver.mjs'), channelId],
      {
        cwd: MCP_DIR,
        env: { ...process.env, HARMONY_URL: target.url, HARMONY_BOT_TOKEN: created.token },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));

    // Answer once the bot's question shows up in the channel.
    const asUser = api(target, user);
    const deadline = Date.now() + 20_000;
    let question: { id: string; content: string } | undefined;
    while (!question) {
      if (Date.now() > deadline) throw new Error('the bot never asked');
      const page = await asUser(`/api/channels/${channelId}/messages`);
      const messages = (
        page.body as { messages: { id: string; content: string; author: { isBot?: boolean } }[] }
      ).messages;
      question = messages.find((message) => message.author.isBot);
      if (!question) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(question.content).toBe('Ready to ship?');
    const reply = await asUser(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { origin: 'https://chat.example.ts.net:18470' },
      body: { content: 'Yes, ship it' },
    });
    expect(reply.status).toBe(201);

    expect(await exited).toBe(0);
    const lines = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Line);
    const channels = lines.find((line) => line.tool === 'list_channels');
    expect(channels?.isError).toBe(false);
    expect(channels?.text).toContain(`id ${channelId}`);
    const asked = lines.find((line) => line.tool === 'ask_human');
    expect(asked?.isError).toBe(false);
    expect(asked?.data).toMatchObject({
      status: 'replied',
      transport: 'websocket',
      questionMessageId: question.id,
    });
    expect(asked?.text).toContain('Yes, ship it');
    expect(out).not.toContain(created.token);
  });
});
