import { expect, test } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { Panel } from '@harmony/shared';
import { ADMIN_LOGIN, DevApi } from './support/dev-api.js';
import { freePort, startEchoBot } from './support/echo-bot.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const origin = new URL(baseURL).origin;
// Set to keep screenshots for a visual check.
const shotsDir = process.env['BOT_CHANNELS_SHOTS_DIR'];
const shot = (name: string) => (shotsDir ? { path: path.join(shotsDir, name) } : {});

const login = ADMIN_LOGIN;
const run = Date.now().toString(36);

test.describe.serial('bot channels, feed mode and scheduled refreshes', () => {
  let api: DevApi;
  let guildId = '';
  let channelId = '';
  let inviteCode = '';
  let token = '';
  let botName = '';
  let bot: ChildProcess | undefined;
  const bob = `bob-${run}@example.com`;

  test.beforeAll(async () => {
    api = new DevApi(baseURL, login);
    const me = await api.me();
    if (!me.isAdmin) {
      throw new Error(`${me.displayName} is not an instance admin; run against an empty database`);
    }
    const guild = await api.createGuild(`Feeds ${run}`);
    guildId = guild.id;
    inviteCode = (await api.createInvite(guild.id)).code;
    channelId = (await api.createChannel(guild.id, `ops-${run}`)).id;

    const port = await freePort();
    botName = `Echo ${run}`;
    const made = await api.createBot({
      name: botName,
      scopes: ['messages.read', 'messages.write', 'commands', 'panels.write'],
      interactionsUrl: `http://127.0.0.1:${String(port)}/interactions`,
    });
    token = made.token;
    await api.addBotToGuild(guildId, made.bot.id);
    bot = await startEchoBot({
      HARMONY_URL: origin,
      HARMONY_BOT_TOKEN: made.token,
      HARMONY_SIGNING_SECRET: made.signingSecret,
      HARMONY_GUILD_ID: guildId,
      HARMONY_DASHBOARD_CHANNEL_ID: channelId,
      // Only the schedule may change the chart: the bot's own point timer is set far out.
      HARMONY_PANEL_INTERVAL_MS: '600000',
      // The e2e server runs the scheduler with a one-second minimum.
      HARMONY_REFRESH_SECONDS: '2',
      PORT: String(port),
    });
    const panels = await api.request<{ panels: Panel[] }>(
      'GET',
      `/api/channels/${channelId}/panels`,
    );
    const host = panels.panels.find((panel) => panel.key === 'host');
    if (!host) throw new Error('the bot never published its panel');
    await api.request('PATCH', `/api/panels/${host.id}`, { pinned: true });
  });

  test.afterAll(() => {
    bot?.kill();
  });

  test('a manager assigns the bot and turns on feed mode from channel settings', async ({
    page,
  }) => {
    await page.context().addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
    await page.goto(`/channels/${guildId}/${channelId}`);
    await page.getByRole('button', { name: 'Channel settings' }).click();
    const dialog = page.getByRole('dialog', { name: `#ops-${run} settings` });
    await dialog.getByRole('tab', { name: 'Bots' }).click();

    await dialog.getByRole('switch', { name: `Assign ${botName}` }).click();
    await dialog.getByRole('switch', { name: 'Bot feed' }).click();
    await expect(dialog.getByRole('switch', { name: `Assign ${botName}` })).toBeChecked();
    await expect(dialog.getByRole('switch', { name: 'Bot feed' })).toBeChecked();
    await page.screenshot(shot('settings-bots-desktop.png'));
    await page.keyboard.press('Escape');

    const bots = page.getByRole('list', { name: 'Bots in this channel' });
    await expect(bots).toContainText(botName);
    await expect(bots).toContainText('Bot feed');
    // The manager holds manage_messages, so the composer stays open for them.
    await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
    await expect(page.getByText(/This channel is a bot feed/)).toHaveCount(0);
  });

  test('members get a disabled composer and the server refuses their posts', async ({
    browser,
  }) => {
    const bobApi = new DevApi(baseURL, bob);
    await bobApi.acceptInvite(inviteCode);
    const context = await browser.newContext();
    await context.addCookies([{ name: 'dev_login', value: bob, url: baseURL }]);
    const page = await context.newPage();
    await page.goto(`/channels/${guildId}/${channelId}`);

    await expect(page.getByText(/This channel is a bot feed/)).toBeVisible();
    const box = page.getByRole('textbox', { name: 'Bot feed: type / to run a command' });
    await expect(box).toBeVisible();
    await box.fill('can I post here?');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Attach files' })).toHaveCount(0);
    await expect(bobApi.send(channelId, 'sneaky')).rejects.toThrow(/403/);

    // A bot still posts, and people see it.
    const posted = await fetch(`${origin}/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Nightly backup finished: 41 GB, 0 errors.' }),
    });
    expect(posted.status).toBe(201);
    await expect(page.getByText('Nightly backup finished')).toBeVisible();

    // The assigned bot is in the header here too.
    await expect(page.getByRole('list', { name: 'Bots in this channel' })).toContainText(botName);
    await page.screenshot(shot('feed-channel-desktop.png'));
    await context.close();
  });

  test('the bot’s schedule refreshes the pinned panel, and a manager can pause it', async ({
    page,
  }) => {
    await page.context().addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
    await page.goto(`/channels/${guildId}/${channelId}`);
    const card = page.getByRole('article', { name: 'Demo host' });
    await expect(card).toBeVisible();
    const chart = card.getByRole('img', { name: /^Load\./ });
    await expect(chart).toBeVisible();

    // Nothing else touches the panel, so a changing chart is the scheduled refresh.
    const before = await chart.getAttribute('aria-label');
    await expect
      .poll(async () => chart.getAttribute('aria-label'), { timeout: 20_000 })
      .not.toBe(before);

    await page.getByRole('button', { name: 'Channel settings' }).click();
    const dialog = page.getByRole('dialog', { name: `#ops-${run} settings` });
    await dialog.getByRole('tab', { name: 'Bots' }).click();
    const row = dialog.getByRole('listitem').filter({ hasText: 'host-panel' });
    await expect(row).toContainText(botName);
    await expect(row).toContainText('every 2 s');
    await expect(row).toContainText('panel host');
    await expect(row).toContainText('Last run ok');
    await page.screenshot(shot('settings-schedules-desktop.png'));

    await row.getByRole('button', { name: 'Pause' }).click();
    await expect(row).toContainText('Paused');
    await page.keyboard.press('Escape');
    // Let a run that was already in flight finish, then the chart must hold still.
    await page.waitForTimeout(2500);
    const paused = await chart.getAttribute('aria-label');
    await page.waitForTimeout(5000);
    expect(await chart.getAttribute('aria-label')).toBe(paused);

    await page.getByRole('button', { name: 'Channel settings' }).click();
    await dialog.getByRole('tab', { name: 'Bots' }).click();
    const resumed = dialog.getByRole('listitem').filter({ hasText: 'host-panel' });
    await resumed.getByRole('button', { name: 'Resume' }).click();
    await expect(resumed).not.toContainText('Paused');
    // The page behind a dialog is hidden from the accessibility tree, so close it before reading.
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => chart.getAttribute('aria-label'), { timeout: 20_000 })
      .not.toBe(paused);
  });
});
