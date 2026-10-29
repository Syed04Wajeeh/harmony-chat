import { expect, test } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { Panel } from '@harmony/shared';
import { ADMIN_LOGIN, DevApi } from './support/dev-api.js';
import { freePort, startEchoBot } from './support/echo-bot.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const origin = new URL(baseURL).origin;
// Set to keep screenshots of the dashboard for a visual check.
const shotsDir = process.env['PANEL_SHOTS_DIR'];
const shot = (name: string) => (shotsDir ? { path: path.join(shotsDir, name) } : {});

const iPhone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const login = ADMIN_LOGIN;
const run = Date.now().toString(36);

const extrasView = {
  title: 'Deploys',
  blocks: [
    {
      type: 'table',
      title: 'Recent deploys',
      columns: [
        { key: 'service', label: 'Service' },
        { key: 'version', label: 'Version' },
        { key: 'environment', label: 'Environment' },
        { key: 'started', label: 'Started' },
        { key: 'duration', label: 'Duration (s)', align: 'right' },
        { key: 'author', label: 'Author' },
        { key: 'result', label: 'Result' },
      ],
      rows: [
        {
          service: 'billing-api',
          version: '2026.10.29-rc3',
          environment: 'production',
          started: '2026-10-29 09:14',
          duration: 312,
          author: 'Nadia Okafor',
          result: 'succeeded',
        },
        {
          service: 'search-indexer',
          version: '2026.10.28',
          environment: 'staging',
          started: '2026-10-28 17:02',
          duration: 148,
          author: 'Tomás Rivera',
          result: 'rolled back',
        },
      ],
    },
    {
      type: 'kv',
      title: 'Release',
      pairs: [
        { key: 'Branch', value: 'main' },
        { key: 'Commit', value: 'a41f9c2' },
        { key: 'Window', value: 'Tuesdays, 09:00 to 11:00' },
      ],
    },
    { type: 'markdown', text: 'Rollbacks need **two approvals**. See `runbook/deploys`.' },
  ],
};

test.describe.serial('bot panels', () => {
  let api: DevApi;
  let channelId = '';
  let generalId = '';
  let guildId = '';
  let guildName = '';
  let token = '';
  let bot: ChildProcess | undefined;
  let inviteCode = '';

  const asBot = async (method: string, apiPath: string, body?: unknown) => {
    const res = await fetch(origin + apiPath, {
      method,
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${apiPath}: ${String(res.status)} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as unknown;
  };
  const put = (key: string, view: unknown, pinned = false, channel = channelId) =>
    asBot('PUT', `/api/channels/${channel}/panels/${key}`, { view, pinned }) as Promise<Panel>;

  test.beforeAll(async () => {
    api = new DevApi(baseURL, login);
    const me = await api.me();
    // Bots can only reach localhost when their owner is the instance admin (the first user).
    // Never skip: a silent skip once hid every bot spec from CI.
    if (!me.isAdmin) {
      throw new Error(`${me.displayName} is not an instance admin; run against an empty database`);
    }
    guildName = `Ops ${run}`;
    const guild = await api.createGuild(guildName);
    guildId = guild.id;
    const general = (await api.channels()).find(
      (c) => c.guildId === guild.id && c.name === 'general',
    );
    if (!general) throw new Error('general channel missing');
    generalId = general.id;
    inviteCode = (await api.createInvite(guild.id)).code;
  });

  test.afterAll(() => {
    bot?.kill();
  });

  test('creates a dashboard channel from the dialog', async ({ page }) => {
    await page.context().addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
    await page.goto(`/channels/${guildId}/${generalId}`);
    await page.getByRole('button', { name: 'Create channel' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create a channel' });
    await dialog.getByLabel(/Dashboard/).check();
    await dialog.getByLabel('Channel name').fill('host');
    await dialog.getByRole('button', { name: 'Create channel' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'host' })).toBeVisible();
    await expect(page.getByText('Nothing here yet')).toBeVisible();
    // Dashboards are listed apart from the text channels, and have no composer.
    await expect(page.getByRole('navigation', { name: 'Text channels' })).toContainText(
      'Dashboards',
    );
    await expect(page.getByRole('textbox', { name: /^Message/ })).toHaveCount(0);
    const created = (await api.channels()).find((c) => c.guildId === guildId && c.name === 'host');
    expect(created?.kind).toBe('dashboard');
    channelId = created?.id ?? '';
  });

  test('a bot publishes a panel, updates it live, and a confirm button gets the bot response', async ({
    page,
    browser,
  }) => {
    const port = await freePort();
    const made = await api.createBot({
      name: `Ops ${run}`,
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
      HARMONY_PANEL_INTERVAL_MS: '1500',
      PORT: String(port),
    });

    await page.context().addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
    await page.goto(`/channels/${guildId}/${channelId}`);
    const card = page.getByRole('article', { name: 'Demo host' });
    await expect(card).toBeVisible();
    await expect(card.getByText('CPU', { exact: true })).toBeVisible();
    await expect(card.getByRole('status')).toHaveCount(0);
    const chart = card.getByRole('img', { name: /^Load\./ });
    await expect(chart).toBeVisible();

    // The bot's own timer keeps appending points: the chart's latest value changes by itself.
    const before = await chart.getAttribute('aria-label');
    await expect
      .poll(async () => chart.getAttribute('aria-label'), { timeout: 15_000 })
      .not.toBe(before);

    // Hovering shows the values at the nearest point.
    await chart.hover({ position: { x: 240, y: 90 } });
    await expect(card.locator('.chart-tooltip')).toBeVisible();
    await expect(card.locator('.chart-tooltip')).toContainText('cpu');
    await page.mouse.move(5, 5);

    // A second panel, driven directly through the bot API.
    await put('live', { title: 'Queue', blocks: [{ type: 'stat', label: 'Depth', value: 41 }] });
    const live = page.getByRole('article', { name: 'Queue' });
    await expect(live.getByText('41')).toBeVisible();
    await put('live', { title: 'Queue', blocks: [{ type: 'stat', label: 'Depth', value: 57 }] });
    await expect(live.getByText('57')).toBeVisible();
    await expect(live.getByText('41')).toHaveCount(0);

    await put('deploys', extrasView);
    await expect(page.getByRole('article', { name: 'Deploys' })).toBeVisible();

    // A button with a confirm dialog: nothing is sent until it is confirmed.
    await card.getByRole('button', { name: 'Restart service' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Restart the demo service?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('li.message-local')).toHaveCount(0);
    await card.getByRole('button', { name: 'Restart service' }).click();
    await confirm.getByRole('button', { name: 'Restart' }).click();
    const response = page.locator('li.message-local');
    await expect(response).toContainText('Restarted');
    await expect(response).toContainText('Only you can see this');
    await expect(card.getByRole('button', { name: 'Restart service' })).toBeEnabled();

    // The Refresh button is answered with update_panel: the panel is replaced in place.
    await card.getByRole('button', { name: 'Refresh' }).click();
    await expect(card.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    await expect(card).toBeVisible();

    await page.locator('.dashboard-scroll').evaluate((el) => el.scrollTo(0, 0));
    await page.screenshot(shot('dashboard-desktop.png'));

    // On a phone the dashboard is one column and never scrolls sideways; wide tables scroll
    // inside their own card.
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: iPhone,
      colorScheme: 'dark',
    });
    const mobile = await phone.newPage();
    await phone.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
    await mobile.goto(`/channels/${guildId}/${channelId}`);
    await expect(mobile.getByRole('article', { name: 'Demo host' })).toBeVisible();
    await expect(mobile.getByRole('article', { name: 'Deploys' })).toBeVisible();
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const table = mobile.locator('.panel-table-scroll').first();
    const scrolls = await table.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrolls).toBe(true);
    await mobile.screenshot(shot('dashboard-mobile.png'));
    await mobile.locator('.dashboard-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await mobile.screenshot(shot('dashboard-mobile-bottom.png'));
    await phone.close();
  });

  test('a button the user may not press is disabled, and the server still refuses it', async ({
    browser,
  }) => {
    const alice = `alice-${run}@example.com`;
    const aliceApi = new DevApi(baseURL, alice);
    await aliceApi.acceptInvite(inviteCode);
    const context = await browser.newContext();
    await context.addCookies([{ name: 'dev_login', value: alice, url: baseURL }]);
    const page = await context.newPage();
    await page.goto(`/channels/${guildId}/${channelId}`);
    const button = page.getByRole('article', { name: 'Demo host' }).getByRole('button', {
      name: 'Restart service',
    });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /manage_messages/);
    // Members cannot pin or remove panels either.
    await expect(page.getByRole('button', { name: 'Remove panel' })).toHaveCount(0);
    const panels = await aliceApi.request<{ panels: Panel[] }>(
      'GET',
      `/api/channels/${channelId}/panels`,
    );
    const demo = panels.panels.find((p) => p.key === 'host');
    await expect(
      aliceApi.request('POST', '/api/interactions/actions', {
        source: { panelId: demo?.id },
        actionId: 'restart',
      }),
    ).rejects.toThrow(/403/);
    await context.close();
  });

  test('a pinned panel sits above the messages of a text channel and folds away', async ({
    page,
  }) => {
    await api.send(generalId, 'A normal message under the pinned panel');
    await put(
      'status',
      {
        title: 'Service status',
        blocks: [
          {
            type: 'status',
            items: [
              { label: 'API', state: 'ok' },
              { label: 'Backups', state: 'warn', detail: 'last run 26 hours ago' },
            ],
          },
        ],
      },
      true,
      generalId,
    );
    await page.context().addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
    await page.goto(`/channels/${guildId}/${generalId}`);
    const strip = page.getByRole('region', { name: 'Pinned panels' });
    await expect(strip.getByRole('article', { name: 'Service status' })).toBeVisible();
    await expect(page.getByText('A normal message under the pinned panel')).toBeVisible();
    await page.screenshot(shot('pinned-strip-desktop.png'));
    await strip.getByRole('button', { name: 'Pinned panel' }).click();
    await expect(strip.getByRole('article')).toHaveCount(0);
    await strip.getByRole('button', { name: 'Service status' }).click();
    await expect(strip.getByRole('article', { name: 'Service status' })).toBeVisible();

    // Someone with manage_channels can unpin it, which removes the strip.
    await strip.getByRole('button', { name: 'Unpin from the channel' }).click();
    await expect(strip).toHaveCount(0);
  });
});
