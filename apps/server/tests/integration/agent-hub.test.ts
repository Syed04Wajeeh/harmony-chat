import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message, Panel } from '@harmony/shared';
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

const MCP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/mcp',
);
const uid = () => randomUUID().slice(0, 8);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Line {
  tool: string;
  isError: boolean;
  text: string;
  data?: Record<string, unknown>;
}

/** The built MCP server driven through the SDK client against the real app, people clicking buttons. */
describe('the agent hub end to end', () => {
  let infra: Infra;
  let target: TestApp;

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@harmony/mcp', 'build'], { encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`mcp build failed: ${build.stdout}${build.stderr}`);
    infra = createInfra();
    target = await infra.startApp({
      PANEL_COALESCE_MS: '0',
      PANEL_RATE_MAX: '1000',
      ACTION_RATE_MAX: '1000',
      MESSAGE_RATE_MAX: '1000',
    });
  });
  afterAll(async () => {
    await infra.stop();
  });

  it('approve, deny and cancel work through real buttons, and only permitted people can decide', async () => {
    const tag = uid();
    const owner = `owner-${tag}@example.com`;
    const alice = `alice-${tag}@example.com`;
    await ensureUser(infra.db, owner, { admin: true });
    const guildId = await createGuild(infra.db, owner, [alice]);
    const textId = await createChannel(infra.db, [owner, alice], { guildId, createdBy: owner });
    const dashboardId = await createChannel(infra.db, [owner, alice], {
      guildId,
      createdBy: owner,
      kind: 'dashboard',
    });
    const created = await createBot(target, owner, {
      scopes: ['messages.read', 'messages.write', 'channels.read', 'panels.write', 'commands'],
    });
    await addBotToGuild(target, owner, guildId, created.bot.id);

    const child = spawn(
      process.execPath,
      [path.join(MCP_DIR, 'tests/agent-driver.mjs'), dashboardId, textId],
      {
        cwd: MCP_DIR,
        env: { ...process.env, HARMONY_URL: target.url, HARMONY_BOT_TOKEN: created.token },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    const lines = () =>
      out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Line);
    const waitForLine = async (tool: string, nth = 1): Promise<Line> => {
      const deadline = Date.now() + 25_000;
      for (;;) {
        const found = lines().filter((line) => line.tool === tool)[nth - 1];
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no ${tool} #${String(nth)} in: ${out}`);
        await sleep(50);
      }
    };

    const asOwner = api(target, owner);
    const asAlice = api(target, alice);
    const pendingApproval = async (): Promise<Message> => {
      const deadline = Date.now() + 25_000;
      for (;;) {
        const page = await asOwner(`/api/channels/${textId}/messages`);
        const messages = (page.body as { messages: Message[] }).messages;
        const found = messages.find((m) => m.author.isBot && m.components?.buttons.length);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('no approval message appeared');
        await sleep(50);
      }
    };
    const click = (as: typeof asOwner, source: object, actionId: string) =>
      as('/api/interactions/actions', { method: 'POST', body: { source, actionId } });

    // 1. A high-risk approval: the second confirmation is on the Approve button.
    const first = await pendingApproval();
    expect(first.content).toContain('Deploy to production');
    expect(first.components?.buttons.map((b) => b.id)).toEqual(['approve', 'deny']);
    expect(first.components?.buttons[0]?.confirm).toBeDefined();
    expect(first.components?.buttons[0]?.requiredPermission).toBe('manage_messages');

    // Alice is in the channel but may not decide: the server refuses her click.
    const refused = await click(asAlice, { messageId: first.id }, 'approve');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'missing_permission' });

    const approved = await click(asOwner, { messageId: first.id }, 'approve');
    expect(approved.status).toBe(202);
    const approval = await waitForLine('request_approval', 1);
    expect(approval.isError).toBe(false);
    expect(approval.data).toMatchObject({
      decision: 'approved',
      by: { login: owner },
      messageId: first.id,
    });
    const after = await asOwner(`/api/channels/${textId}/messages`);
    const edited = (after.body as { messages: Message[] }).messages.find((m) => m.id === first.id);
    expect(edited?.content).toContain('**Approved** by');
    expect(edited?.components).toBeUndefined();
    expect(edited?.editedAt).not.toBeNull();

    // 2. A second approval, denied.
    let second: Message | undefined;
    const deadline = Date.now() + 25_000;
    while (!second) {
      if (Date.now() > deadline) throw new Error('no second approval');
      const page = await asOwner(`/api/channels/${textId}/messages`);
      second = (page.body as { messages: Message[] }).messages.find(
        (m) => m.components?.buttons.length && m.id !== first.id,
      );
      if (!second) await sleep(50);
    }
    expect((await click(asOwner, { messageId: second.id }, 'deny')).status).toBe(202);
    const denial = await waitForLine('request_approval', 2);
    expect(denial.data).toMatchObject({ decision: 'denied', by: { login: owner } });

    // 3. The run panel shows the work; Cancel stops the agent.
    await waitForLine('update_run', 1);
    const listed = await botApi(target, created.token)(`/api/channels/${dashboardId}/panels`);
    const panel = (listed.body as { panels: Panel[] }).panels.find((p) => p.key.startsWith('run-'));
    expect(panel?.view.title).toBe('Agent run: Ship the release');
    const cancelButton = panel?.view.blocks
      .flatMap((b) => (b.type === 'actions' ? b.buttons : []))
      .find((b) => b.id === 'cancel');
    expect(cancelButton?.requiredPermission).toBe('manage_messages');

    expect((await click(asAlice, { panelId: panel?.id }, 'cancel')).status).toBe(403);
    expect((await click(asOwner, { panelId: panel?.id }, 'cancel')).status).toBe(202);

    const stopped = await waitForLine('update_run', 2);
    expect(stopped.isError).toBe(true);
    expect(stopped.text).toContain('cancelled by');
    expect(stopped.text).toContain('stop working');
    expect(await exited).toBe(0);

    const final = await botApi(target, created.token)(`/api/channels/${dashboardId}/panels`);
    const last = (final.body as { panels: Panel[] }).panels.find((p) => p.id === panel?.id);
    expect(JSON.stringify(last?.view)).toContain('Cancelled');
    expect(JSON.stringify(last?.view)).not.toContain('"actions"');
    expect(out).not.toContain(created.token);
  }, 90_000);
});
