import { expect, test } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ADMIN_LOGIN, DevApi } from './support/dev-api.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const origin = new URL(baseURL).origin;
// Set to keep screenshots of the run panel and the approval message for a visual check.
const shotsDir = process.env['AGENT_SHOTS_DIR'];
const shot = (name: string) => (shotsDir ? { path: path.join(shotsDir, name) } : {});

const iPhone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const run = Date.now().toString(36);
const demoDir = path.resolve('../../examples/agent-demo');
const mcpEntry = path.resolve('../../packages/mcp/dist/index.js');

/** A scripted agent (examples/agent-demo) driving the real MCP server against the dev stack. */
test.describe.serial('the agent hub', () => {
  let agent: ChildProcess | undefined;
  let agentLog = '';

  test.afterAll(() => {
    agent?.kill();
  });

  test('a run panel follows the agent, and a person approves a deploy from chat', async ({
    page,
    browser,
  }) => {
    const build = spawnSync('pnpm', ['--filter', '@harmony/mcp', 'build'], { encoding: 'utf8' });
    if (build.status !== 0 || !existsSync(mcpEntry)) {
      throw new Error(`mcp build failed: ${build.stdout}${build.stderr}`);
    }
    const api = new DevApi(baseURL, ADMIN_LOGIN);
    const guild = await api.createGuild(`Agents ${run}`);
    const dashboard = await api.createChannel(guild.id, 'agents', { kind: 'dashboard' });
    const approvals = await api.createChannel(guild.id, 'approvals');
    const made = await api.createBot({
      name: `Release agent ${run}`,
      scopes: ['messages.read', 'messages.write', 'channels.read', 'panels.write', 'commands'],
    });
    await api.addBotToGuild(guild.id, made.bot.id);

    agent = spawn(process.execPath, ['demo.ts'], {
      cwd: demoDir,
      env: {
        ...process.env,
        HARMONY_URL: origin,
        HARMONY_BOT_TOKEN: made.token,
        DEMO_DASHBOARD_CHANNEL: dashboard.id,
        DEMO_APPROVAL_CHANNEL: approvals.id,
        DEMO_PACE_MS: '2500',
        DEMO_APPROVAL_SECONDS: '300',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agent.stdout?.on('data', (chunk: Buffer) => (agentLog += chunk.toString()));
    agent.stderr?.on('data', (chunk: Buffer) => (agentLog += chunk.toString()));

    await page.context().addCookies([{ name: 'dev_login', value: ADMIN_LOGIN, url: baseURL }]);
    await page.goto(`/channels/${guild.id}/${dashboard.id}`);
    const panel = page.getByRole('article', { name: 'Agent run: Release 2.4' });
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText('Running');
    await expect(panel).toContainText('Running the test suite');
    await page.screenshot(shot('run-running-desktop.png'));

    // The agent asks before deploying: the run shows it is waiting, with a Cancel button.
    await expect(panel).toContainText('Waiting for approval', { timeout: 20_000 });
    await expect(panel.getByRole('button', { name: 'Cancel run' })).toBeVisible();
    await page.screenshot(shot('run-waiting-desktop.png'));

    // The approval is a message with buttons in the approvals channel.
    await page.goto(`/channels/${guild.id}/${approvals.id}`);
    const message = page.locator('li.message', { hasText: 'Deploy release 2.4 to production' });
    await expect(message).toBeVisible();
    await expect(message.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(message.getByRole('button', { name: 'Deny' })).toBeVisible();
    await page.screenshot(shot('approval-before-desktop.png'));

    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: iPhone,
      colorScheme: 'dark',
    });
    await phone.addCookies([{ name: 'dev_login', value: ADMIN_LOGIN, url: baseURL }]);
    const mobile = await phone.newPage();
    await mobile.goto(`/channels/${guild.id}/${dashboard.id}`);
    await expect(mobile.getByRole('article', { name: 'Agent run: Release 2.4' })).toContainText(
      'Waiting for approval',
    );
    await mobile.screenshot(shot('run-waiting-mobile.png'));
    await mobile.goto(`/channels/${guild.id}/${approvals.id}`);
    await expect(mobile.getByRole('button', { name: 'Approve' })).toBeVisible();
    await mobile.screenshot(shot('approval-before-mobile.png'));

    // High risk asks twice: the first press opens a confirmation, nothing is decided yet.
    await message.getByRole('button', { name: 'Approve' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Approve a high-risk action?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(message.getByRole('button', { name: 'Approve' })).toBeVisible();
    await message.getByRole('button', { name: 'Approve' }).click();
    await confirm.getByRole('button', { name: 'Approve' }).click();

    // The message now says who decided, and the buttons are gone, on every screen.
    await expect(message).toContainText('Approved by');
    await expect(message.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(message.getByRole('button', { name: 'Deny' })).toHaveCount(0);
    await page.screenshot(shot('approval-after-desktop.png'));
    await expect(mobile.getByText('Approved by')).toBeVisible();
    await mobile.screenshot(shot('approval-after-mobile.png'));

    // The agent carries on and finishes; the panel keeps the result and loses its Cancel button.
    await page.goto(`/channels/${guild.id}/${dashboard.id}`);
    const done = page.getByRole('article', { name: 'Agent run: Release 2.4' });
    await expect(done).toContainText('Done', { timeout: 30_000 });
    await expect(done).toContainText('Release 2.4 is live on all hosts');
    await expect(done.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
    await page.screenshot(shot('run-done-desktop.png'));
    await mobile.goto(`/channels/${guild.id}/${dashboard.id}`);
    await expect(mobile.getByRole('article', { name: 'Agent run: Release 2.4' })).toContainText(
      'Done',
    );
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await mobile.screenshot(shot('run-done-mobile.png'));
    await phone.close();
    expect(agentLog).toContain('request_approval');
    await expect.poll(() => agent?.exitCode, { timeout: 15_000 }).toBe(0);
  });
});
