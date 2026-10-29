import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { DevApi } from './support/dev-api.js';
import { emojiPng, scenePng } from './support/png.js';
import { freePort, startEchoBot } from './support/echo-bot.js';
import { seedBookClub, type Seeded } from './support/seed.js';
import {
  generateEvents,
  seedIntegrations,
  type IntegrationsSeed,
} from './support/seed-integrations.js';

/**
 * Seeds a fictional book club and captures the screenshots used in the README.
 * Run with E2E_SCREENSHOTS=1 (see apps/web/e2e/README in the project README).
 */
const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const outDir = process.env['SHOTS_DIR'] ?? path.resolve('../../docs/screenshots');
const shot = (name: string) => path.join(outDir, `${name}.png`);

const iPhone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: iPhone,
  colorScheme: 'dark' as const,
};
const DESKTOP = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: 'dark' as const,
};

let seeded: Seeded;
const background: BrowserContext[] = [];
let linusPage: Page;

const DEFAULT_APPEARANCE = {
  mode: 'system',
  themeId: 'harmony-dark',
  density: 'cozy',
  panels: 'floating',
  fontScale: 1,
  messageFont: 'manrope',
  useGuildAccent: true,
  reducedMotion: 'system',
  customCssEnabled: false,
  customCss: '',
};

/** Appearance is saved on the server per user, so every shot starts from the defaults it asks for. */
async function setAppearance(login: string, patch: Record<string, unknown> = {}) {
  const api = new DevApi(baseURL, login);
  const { version } = await api.request<{ version: number }>('GET', '/api/me/settings');
  await api.request('PATCH', '/api/me/settings', {
    version,
    appearance: { ...DEFAULT_APPEARANCE, ...patch },
  });
}

async function visit(
  browser: Browser,
  login: string,
  options: Parameters<Browser['newContext']>[0],
  url: string,
  appearance?: { theme?: string; density?: string; panels?: string },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  const { theme, ...rest } = appearance ?? {};
  await setAppearance(login, { ...rest, ...(theme && { mode: theme }) });
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  const page = await context.newPage();
  await page.goto(url);
  return { context, page };
}

/** Keeps a few people connected so presence dots and typing are real. */
async function connectOthers(browser: Browser) {
  const people = { linus: 'online', grace: 'idle', alan: 'dnd' } as const;
  for (const [name, status] of Object.entries(people) as [keyof typeof people, string][]) {
    const { context, page } = await visit(
      browser,
      `${name}@example.com`,
      { viewport: { width: 900, height: 700 } },
      `/channels/${seeded.guildId}/${seeded.channels.general}`,
    );
    background.push(context);
    await page.getByRole('textbox', { name: /^Message #/ }).waitFor();
    if (name === 'linus') linusPage = page;
    await seeded.api[name].setStatus(status as 'online' | 'idle' | 'dnd');
  }
}

/** Gives Ada something unread in #general again. */
async function freshMessages() {
  await seeded.api.linus.send(
    seeded.channels.general,
    'See you all on Friday! I am bringing the good tea.',
  );
  await seeded.api.margaret.send(
    seeded.channels.general,
    'And I will bring the cake, as promised 🍰',
  );
}

async function settle(page: Page) {
  await page.getByRole('list', { name: 'Messages' }).waitFor();
  await page.evaluate(() => document.fonts.load('15px "Manrope Variable"'));
  await page.waitForFunction(() => document.fonts.ready.then(() => true));
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  await page.waitForTimeout(500);
}

const general = () => `/channels/${seeded.guildId}/${seeded.channels.general}`;

test.beforeAll(async ({ browser }) => {
  seeded = await seedBookClub(baseURL);
  await connectOthers(browser);
});

test.afterAll(async () => {
  await Promise.all(background.map((context) => context.close()));
});

test('mobile', async ({ browser }) => {
  const { context, page } = await visit(browser, 'ada@example.com', PHONE, general());
  await settle(page);

  await page.screenshot({ path: shot('mobile-channel') });

  // Drawer with unread badges (Ada has not opened #recommendations or the DM yet).
  await page.getByRole('button', { name: 'Open navigation' }).tap();
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot('mobile-drawer') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // Member list drawer.
  await page.getByRole('button', { name: 'Member list' }).tap();
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot('mobile-members') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // Reply + reactions.
  await page.locator(`#m-${seeded.replyMessageId}`).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('mobile-reactions') });

  // Image attachment.
  await page.locator(`#m-${seeded.imageMessageId}`).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('mobile-image') });

  // Long-press action sheet.
  const target = page.locator(`#m-${seeded.replyMessageId} .message-content`);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('message not visible');
  const cdp = await context.newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot('mobile-actions') });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.keyboard.press('Escape');

  await context.close();
});

test('mobile composer with the keyboard up', async ({ browser }) => {
  // A short viewport stands in for the on-screen keyboard.
  const { context, page } = await visit(
    browser,
    'ada@example.com',
    { ...PHONE, viewport: { width: 390, height: 470 } },
    general(),
  );
  await settle(page);
  const box = page.getByRole('textbox', { name: /^Message #/ });
  await box.click();
  await box.pressSequentially('Sounds great, @Li');
  await page.getByRole('listbox', { name: 'Mention suggestions' }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('mobile-keyboard') });
  await context.close();
});

test('mobile home, light theme and invite', async ({ browser }) => {
  const home = await visit(browser, 'ada@example.com', PHONE, '/channels/@me');
  await home.page.locator('.home-list').waitFor();
  await home.page.waitForTimeout(400);
  await home.page.screenshot({ path: shot('mobile-home') });
  await home.context.close();

  const light = await visit(
    browser,
    'ada@example.com',
    { ...PHONE, colorScheme: 'light' },
    general(),
  );
  await settle(light.page);
  await light.page.screenshot({ path: shot('mobile-light-channel') });
  await light.page.getByRole('button', { name: 'Open navigation' }).tap();
  await light.page.waitForTimeout(500);
  await light.page.screenshot({ path: shot('mobile-light-drawer') });
  await light.context.close();

  const lightSettings = await visit(
    browser,
    'ada@example.com',
    { ...PHONE, colorScheme: 'light' },
    '/settings/user/appearance',
  );
  await lightSettings.page.getByRole('heading', { level: 1, name: 'Appearance' }).waitFor();
  await lightSettings.page.waitForTimeout(400);
  await lightSettings.page.screenshot({ path: shot('mobile-light-settings') });
  await lightSettings.context.close();

  const invite = await visit(
    browser,
    'newcomer@example.com',
    PHONE,
    `/invite/${seeded.inviteCode}`,
  );
  await invite.page.getByRole('button', { name: 'Accept invite' }).waitFor();
  await invite.page.waitForTimeout(300);
  await invite.page.screenshot({ path: shot('mobile-invite') });
  await invite.context.close();
});

test('desktop', async ({ browser }) => {
  await freshMessages();
  const { context, page } = await visit(browser, 'ada@example.com', DESKTOP, general());
  await settle(page);
  await linusPage
    .getByRole('textbox', { name: /^Message #/ })
    .pressSequentially('Does anyone have the address for', { delay: 20 });
  await page.getByText('Linus is typing…').waitFor();
  await page.screenshot({ path: shot('desktop-channel') });

  // Reply + reactions + hover toolbar.
  const reply = page.locator(`#m-${seeded.replyMessageId}`);
  await reply.scrollIntoViewIfNeeded();
  await reply.hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('desktop-replies-reactions') });

  // Emoji picker from the toolbar.
  await reply.getByRole('button', { name: 'Add reaction' }).first().click();
  await page.getByRole('listbox', { name: 'Emoji' }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('desktop-emoji-picker') });
  await page.keyboard.press('Escape');

  // Search.
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('searchbox', { name: 'Search messages' }).fill('piranesi');
  await page.locator('.search-result').first().waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('desktop-search') });
  await page.keyboard.press('Escape');

  // Pins.
  await page.getByRole('button', { name: 'Pinned messages' }).click();
  await page.locator('.pin-item').first().waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('desktop-pins') });
  await page.keyboard.press('Escape');

  // Direct message.
  await page.getByRole('link', { name: 'Direct messages' }).first().click();
  await page.getByRole('link', { name: /Grace/ }).first().click();
  await page.getByText('Hey, could you send me the spreadsheet').first().waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot('desktop-dm') });
  await context.close();

  const light = await visit(
    browser,
    'ada@example.com',
    { ...DESKTOP, colorScheme: 'light' },
    general(),
  );
  await settle(light.page);
  await light.page.screenshot({ path: shot('desktop-light-channel') });
  const lightReply = light.page.locator(`#m-${seeded.replyMessageId}`);
  await lightReply.scrollIntoViewIfNeeded();
  await lightReply.hover();
  await light.page.waitForTimeout(300);
  await light.page.screenshot({ path: shot('desktop-light-replies') });
  await light.context.close();

  const lightSettings = await visit(
    browser,
    'ada@example.com',
    { ...DESKTOP, colorScheme: 'light' },
    '/settings/user/appearance',
  );
  await lightSettings.page.getByRole('heading', { level: 1, name: 'Appearance' }).waitFor();
  await lightSettings.page.waitForTimeout(400);
  await lightSettings.page.screenshot({ path: shot('desktop-light-settings') });
  await lightSettings.context.close();

  const settings = await visit(browser, 'ada@example.com', DESKTOP, '/settings/user/appearance');
  await settings.page.getByRole('heading', { level: 1, name: 'Appearance' }).waitFor();
  await settings.page.waitForTimeout(400);
  await settings.page.screenshot({ path: shot('desktop-appearance') });
  await settings.context.close();

  for (const [name, appearance] of [
    ['desktop-compact', { density: 'compact' }],
    ['desktop-flat', { panels: 'flat' }],
  ] as const) {
    const variant = await visit(browser, 'ada@example.com', DESKTOP, general(), appearance);
    await settle(variant.page);
    await variant.page.screenshot({ path: shot(name) });
    await variant.context.close();
  }

  const invite = await visit(
    browser,
    'newcomer@example.com',
    DESKTOP,
    `/invite/${seeded.inviteCode}`,
  );
  await invite.page.getByRole('button', { name: 'Accept invite' }).waitFor();
  await invite.page.waitForTimeout(300);
  await invite.page.screenshot({ path: shot('desktop-invite') });
  await invite.context.close();
});

/**
 * The outbox worker is a separate process in a real deployment and the dev server does not start
 * one, so the shots that need delivery results start it themselves unless one is already running.
 */
function startWorker(): ChildProcess {
  const worker = spawn('pnpm', ['--filter', '@harmony/server', 'exec', 'tsx', 'src/worker.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://harmony:dev@127.0.0.1:15432/harmony',
      REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:16379',
      OUTBOUND_PRIVATE_ALLOWLIST: 'localhost,127.0.0.1',
      HEARTBEAT_FILE: path.join(os.tmpdir(), `harmony-shots-worker-${String(process.pid)}`),
      WORKER_POLL_MS: '500',
      DELIVERY_BACKOFF_BASE_MS: '500',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  worker.stderr?.on('data', (chunk: Buffer) => console.log(`worker: ${chunk.toString().trim()}`));
  return worker;
}

/** `pnpm` and `tsx` sit between us and the node process, so signal the whole group. */
function stopWorker(worker: ChildProcess | undefined) {
  if (worker?.pid) {
    try {
      process.kill(-worker.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

test.describe('integrations', () => {
  let home: IntegrationsSeed;
  let worker: ChildProcess | undefined;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    worker = startWorker();
    const { ada, linus, grace } = seeded.api;
    home = await seedIntegrations(baseURL, ada, [linus, grace]);
    await generateEvents(ada, home.channels.general, 6);
    // The worker delivers events in the background (`tsx src/worker.ts`); wait for its first results.
    await expect
      .poll(async () => (await ada.deliveries(home.botId)).some((d) => d.status === 'failed'), {
        timeout: 60_000,
        message: 'no failed delivery: is the worker running?',
      })
      .toBe(true);
  });

  test.afterAll(async () => {
    stopWorker(worker);
    await home.stop();
  });

  const forms = [
    ['mobile', PHONE],
    ['desktop', DESKTOP],
  ] as const;
  const channelUrl = (channelId: string) => `/channels/${home.guildId}/${channelId}`;

  for (const [prefix, options] of forms) {
    test(`${prefix} embeds and slash commands`, async ({ browser }) => {
      const alerts = await visit(
        browser,
        'ada@example.com',
        options,
        channelUrl(home.channels.alerts),
      );
      await settle(alerts.page);
      await alerts.page.locator('.embed').last().waitFor();
      await alerts.page.screenshot({ path: shot(`${prefix}-embeds-alerts`) });
      await alerts.context.close();

      const jobs = await visit(browser, 'ada@example.com', options, channelUrl(home.channels.jobs));
      await settle(jobs.page);
      await jobs.page.locator('.embed').last().waitFor();
      // Phones cannot fit the whole message; start at its header.
      await jobs.page
        .locator('li.message', { has: jobs.page.locator('.embed') })
        .evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await jobs.page.waitForTimeout(200);
      await jobs.page.screenshot({ path: shot(`${prefix}-embeds-jobs`) });
      await jobs.context.close();

      const { context, page } = await visit(
        browser,
        'ada@example.com',
        options,
        channelUrl(home.channels.general),
      );
      await settle(page);
      const box = page.getByRole('textbox', { name: /^Message #/ });
      await box.click();
      await box.fill('/');
      await page.getByRole('listbox', { name: 'Slash commands' }).waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot(`${prefix}-slash-autocomplete`) });

      await page.getByRole('option', { name: /\/echo/ }).click();
      await page.getByRole('textbox', { name: 'text' }).fill('Friday works for me, see you there');
      await page.screenshot({ path: shot(`${prefix}-slash-options`) });
      await page.getByRole('textbox', { name: 'text' }).press('Enter');
      await page.getByText('Only you can see this').waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot(`${prefix}-ephemeral-reply`) });
      await context.close();
    });

    test(`${prefix} settings`, async ({ browser }) => {
      const settingsList = await visit(
        browser,
        'ada@example.com',
        options,
        `/settings/server/${home.guildId}`,
      );
      await settingsList.page
        .getByRole('navigation', { name: 'Server settings sections' })
        .waitFor();
      await settingsList.page.waitForTimeout(300);
      await settingsList.page.screenshot({ path: shot(`${prefix}-settings`) });
      await settingsList.context.close();

      const integrations = await visit(
        browser,
        'ada@example.com',
        options,
        `/settings/server/${home.guildId}/integrations`,
      );
      await integrations.page.getByRole('list', { name: 'Webhooks in alerts' }).waitFor();
      await integrations.page.waitForTimeout(300);
      await integrations.page.screenshot({ path: shot(`${prefix}-integrations`) });

      // The real response is swapped for a fake token so no working URL ends up in an image.
      await integrations.page.route('**/api/channels/*/webhooks', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const response = await route.fetch();
        const body = (await response.json()) as object;
        return route.fulfill({ response, json: { ...body, url: home.fakeWebhookPath } });
      });
      await integrations.page.getByRole('button', { name: 'Create webhook' }).click();
      await integrations.page.getByLabel('Channel').selectOption({ label: '#alerts' });
      await integrations.page.getByLabel('Name').fill('Backup job');
      await integrations.page.getByRole('button', { name: 'Create webhook' }).last().click();
      await integrations.page.getByText("You won't see this again").waitFor();
      await integrations.page.waitForTimeout(400);
      await integrations.page.screenshot({ path: shot(`${prefix}-webhook-create`) });
      await integrations.context.close();

      const bot = await visit(
        browser,
        'ada@example.com',
        options,
        `/settings/user/bots/${home.botId}`,
      );
      await bot.page.getByRole('heading', { level: 1, name: 'Echo' }).waitFor();
      await bot.page.waitForTimeout(400);
      await bot.page.screenshot({ path: shot(`${prefix}-bot-settings`) });

      const deliveries = bot.page.getByRole('heading', { name: 'Event deliveries' });
      await deliveries.scrollIntoViewIfNeeded();
      await bot.page.locator('.delivery-table tbody tr').first().waitFor();
      await bot.page.evaluate(() =>
        document.querySelector('.settings-main')?.scrollBy({ top: 300 }),
      );
      await bot.page.waitForTimeout(300);
      await deliveries.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await bot.page.waitForTimeout(300);
      await bot.page.screenshot({ path: shot(`${prefix}-delivery-log`) });
      await bot.context.close();
    });
  }
});

let pollCreated = false;
/** One poll with votes, created by whichever form runs first. */
async function ensurePoll() {
  if (pollCreated) return;
  pollCreated = true;
  const { api, channels } = seeded;
  const poll = await api.ada.createPoll(channels.general, 'Which book should we read next?', [
    'Piranesi',
    'The Left Hand of Darkness',
    'Klara and the Sun',
    'Middlemarch',
  ]);
  await api.ada.votePoll(poll.id, [1]);
  await api.linus.votePoll(poll.id, [1]);
  await api.grace.votePoll(poll.id, [3]);
  await api.alan.votePoll(poll.id, [1]);
  await api.margaret.votePoll(poll.id, [2]);
}

test.describe('modules', () => {
  for (const [prefix, options] of [
    ['mobile', PHONE],
    ['desktop', DESKTOP],
  ] as const) {
    test(`${prefix} polls and the modules page`, async ({ browser }) => {
      await ensurePoll();

      const channel = await visit(browser, 'ada@example.com', options, general());
      await settle(channel.page);
      await channel.page.locator('.poll').last().scrollIntoViewIfNeeded();
      await channel.page.waitForTimeout(500);
      await channel.page.screenshot({ path: shot(`${prefix}-poll`) });

      await channel.page.getByRole('button', { name: 'Add to message' }).click();
      await channel.page.getByRole('menuitem', { name: 'Create poll' }).click();
      const dialog = channel.page.getByRole('dialog', { name: 'Create a poll' });
      await dialog.getByLabel('Question').fill('Friday: tea or coffee?');
      await dialog.getByLabel('Option 1').fill('Tea');
      await dialog.getByLabel('Option 2').fill('Coffee');
      await channel.page.waitForTimeout(500);
      await channel.page.screenshot({ path: shot(`${prefix}-poll-create`) });
      await channel.context.close();

      const modules = await visit(
        browser,
        'ada@example.com',
        options,
        `/settings/server/${seeded.guildId}/modules`,
      );
      await modules.page.getByRole('switch', { name: 'Polls enabled' }).waitFor();
      await modules.page.waitForTimeout(500);
      await modules.page.screenshot({ path: shot(`${prefix}-modules`) });
      await modules.context.close();
    });
  }
});

test.describe('roles', () => {
  test('roles editor, hoisted member list and channel permissions', async ({ browser }) => {
    const { api, ids, guildId, channels } = seeded;
    const make = (name: string, color: number, hoist: boolean, permissions: string[] = []) =>
      api.ada.createRole(guildId, { name, color, hoist, permissions });
    // New roles land at the bottom, so the first one created ends up highest.
    const moderator = await make('Moderator', 0xe5534b, true, [
      'manage_messages',
      'kick_members',
      'manage_nicknames',
    ]);
    const librarian = await make('Librarian', 0x2da58e, true, ['manage_channels', 'pins.pin']);
    const nightOwl = await make('Night owl', 0xa371f7, false);
    const earlyBird = await make('Early bird', 0xd4a72c, false);
    await api.ada.assignRole(guildId, ids.linus, moderator.id);
    await api.ada.assignRole(guildId, ids.grace, librarian.id);
    await api.ada.assignRole(guildId, ids.grace, nightOwl.id);
    await api.ada.assignRole(guildId, ids.margaret, librarian.id);
    await api.ada.assignRole(guildId, ids.alan, earlyBird.id);
    await api.ada.setNickname(guildId, ids.margaret, 'Maggie');
    const everyone = (await api.ada.roles(guildId)).find((role) => role.isDefault)?.id ?? '';
    await api.ada.putOverwrite(channels.offTopic, 'role', everyone, { deny: ['attach_files'] });
    await api.ada.putOverwrite(channels.offTopic, 'role', librarian.id, {
      allow: ['manage_messages'],
    });
    await api.ada.putOverwrite(channels.offTopic, 'member', ids.alan, { deny: ['add_reactions'] });

    for (const [prefix, options] of [
      ['desktop', DESKTOP],
      ['mobile', PHONE],
    ] as const) {
      const settings = await visit(
        browser,
        'ada@example.com',
        options,
        `/settings/server/${guildId}/roles`,
      );
      await settings.page.getByRole('button', { name: 'Librarian' }).first().click();
      await settings.page.getByLabel('Role name').waitFor();
      await settings.page.waitForTimeout(500);
      await settings.page.screenshot({ path: shot(`${prefix}-roles`) });
      await settings.page.getByRole('tab', { name: 'Permissions' }).click();
      await settings.page.waitForTimeout(400);
      await settings.page.screenshot({ path: shot(`${prefix}-roles-permissions`) });
      await settings.context.close();
    }

    const members = await visit(browser, 'ada@example.com', DESKTOP, general());
    await settle(members.page);
    await members.page.getByRole('complementary', { name: 'Members' }).waitFor();
    await members.page.getByText('Moderator').first().waitFor();
    await members.page.waitForTimeout(500);
    await members.page.screenshot({ path: shot('desktop-members-roles') });
    await members.context.close();

    const phone = await visit(browser, 'ada@example.com', PHONE, general());
    await settle(phone.page);
    await phone.page.getByRole('button', { name: 'Member list' }).tap();
    await phone.page.getByText('Moderator').first().waitFor();
    await phone.page.waitForTimeout(600);
    await phone.page.screenshot({ path: shot('mobile-members-roles') });
    await phone.context.close();

    const channel = await visit(
      browser,
      'ada@example.com',
      DESKTOP,
      `/channels/${guildId}/${channels.offTopic}`,
    );
    await settle(channel.page);
    await channel.page.getByRole('button', { name: 'Channel settings' }).click();
    await channel.page.getByRole('tab', { name: 'Permissions' }).click();
    await channel.page.getByRole('tab', { name: 'Librarian' }).click();
    await channel.page.getByText('Manage messages').first().waitFor();
    await channel.page.waitForTimeout(500);
    await channel.page.screenshot({ path: shot('desktop-channel-permissions') });
    await channel.context.close();
  });
});

test.describe('customization', () => {
  const ada = 'ada@example.com';
  const sampleCss = [
    '/* Tint the message under the pointer. */',
    '[data-harmony="message"]:hover {',
    '  background: var(--color-bg-hover);',
    '}',
    '',
    '[data-harmony="sidebar"] {',
    '  letter-spacing: 0.01em;',
    '}',
    '',
    '@import url("https://fonts.example/more.css");',
  ].join('\n');

  test.beforeAll(async () => {
    const banner = await seeded.api.ada.upload('banner.png', scenePng(960, 320));
    await seeded.api.ada.request('PATCH', `/api/guilds/${seeded.guildId}`, {
      accentColor: 0x3b9ec7,
      bannerAttachmentId: banner.id,
      description: 'A cozy club for people who read slowly and talk fast. New members welcome.',
    });
  });

  for (const [prefix, device] of [
    ['desktop', DESKTOP],
    ['mobile', PHONE],
  ] as const) {
    test(`${prefix} themes, editor and custom CSS`, async ({ browser }) => {
      const gallery = await visit(browser, ada, device, '/settings/user/themes');
      await gallery.page.getByRole('heading', { level: 1, name: 'Themes' }).waitFor();
      await gallery.page.waitForTimeout(500);
      await gallery.page.screenshot({ path: shot(`${prefix}-themes`) });
      await gallery.context.close();

      const editor = await visit(
        browser,
        ada,
        device,
        '/settings/user/themes/new?from=harmony-dark',
      );
      await editor.page.getByRole('textbox', { name: 'Muted value' }).fill('#2f2e2b');
      await editor.page.getByText(/below AA and may be hard to read/).waitFor();
      await editor.page.waitForTimeout(400);
      await editor.page.screenshot({ path: shot(`${prefix}-theme-editor`) });
      await editor.page.locator('[data-contrast="muted"]').scrollIntoViewIfNeeded();
      await editor.page.waitForTimeout(300);
      await editor.page.screenshot({ path: shot(`${prefix}-theme-contrast`) });
      await editor.context.close();

      const css = await visit(browser, ada, device, '/settings/user/advanced');
      await css.page.getByLabel('Stylesheet').fill(sampleCss);
      await css.page.getByText(/These are removed when saved/).waitFor();
      await css.page.waitForTimeout(300);
      await css.page.screenshot({ path: shot(`${prefix}-custom-css`) });
      await css.context.close();
    });

    test(`${prefix} presets in the chat view`, async ({ browser }) => {
      for (const themeId of ['midnight', 'rose', 'high-contrast']) {
        await setAppearance(ada, { themeId, useGuildAccent: false });
        const context = await browser.newContext(device);
        await context.addCookies([{ name: 'dev_login', value: ada, url: baseURL }]);
        const page = await context.newPage();
        await page.goto(general());
        await settle(page);
        await page.screenshot({ path: shot(`${prefix}-theme-${themeId}`) });
        await context.close();
      }
    });

    test(`${prefix} guild banner, accent and invite`, async ({ browser }) => {
      const guild = await visit(browser, ada, device, general());
      await settle(guild.page);
      if (prefix === 'mobile') {
        await guild.page.getByRole('button', { name: 'Open navigation' }).tap();
        await guild.page.waitForTimeout(500);
      }
      await guild.page.screenshot({ path: shot(`${prefix}-guild-branding`) });
      await guild.context.close();

      const settings = await visit(
        browser,
        ada,
        device,
        `/settings/server/${seeded.guildId}/overview`,
      );
      await settings.page.getByRole('heading', { level: 1, name: 'Overview' }).waitFor();
      await settings.page.waitForTimeout(600);
      await settings.page.screenshot({ path: shot(`${prefix}-server-branding`), fullPage: false });
      await settings.context.close();

      const invite = await visit(
        browser,
        'visitor@example.com',
        device,
        `/invite/${seeded.inviteCode}`,
      );
      await invite.page.getByRole('button', { name: 'Accept invite' }).waitFor();
      await invite.page.waitForTimeout(600);
      await invite.page.screenshot({ path: shot(`${prefix}-invite-banner`) });
      await invite.context.close();
    });
  }
});

test.describe('profiles, emoji and perks', () => {
  const ada = 'ada@example.com';
  const emojiIds: Record<string, string> = {};
  const SHAPES = [
    ['party_blob', 'face', [255, 196, 61]],
    ['sunny', 'sun', [255, 170, 40]],
    ['leafy', 'flower', [236, 110, 160]],
    ['heart_box', 'heart', [232, 70, 90]],
    ['moon', 'moon', [160, 170, 230]],
  ] as const;

  test.beforeAll(async () => {
    const { api, ids, guildId, channels } = seeded;
    for (const name of ['ada', 'linus', 'grace'] as const) {
      for (const perk of [
        'animated_avatar',
        'profile_banner_image',
        'cross_server_emoji',
        'custom_status_emoji',
      ]) {
        await api.ada.request('PUT', `/api/admin/users/${ids[name]}/perks`, { perk });
      }
    }
    for (const [name, shape, color] of SHAPES) {
      const file = await api.ada.upload(`${name}.png`, emojiPng(shape, [...color]));
      const created = await api.ada.request<{ id: string }>(
        'POST',
        `/api/guilds/${guildId}/emoji`,
        {
          name,
          attachmentId: file.id,
        },
      );
      emojiIds[name] = created.id;
    }
    const token = (name: string) => `<:${name}:${emojiIds[name] ?? ''}>`;

    const bookworm = await api.ada.createRole(guildId, { name: 'Bookworm', color: 0xd264b6 });
    await api.ada.assignRole(guildId, ids.linus, bookworm.id);
    await api.ada.setNickname(guildId, ids.linus, 'Linus the Short-Book Advocate');

    const banner = await api.linus.upload('linus-banner.png', scenePng(960, 320));
    await api.linus.request('PATCH', '/api/me/profile', {
      bannerAttachmentId: banner.id,
      accentColor: 0x539bf5,
      pronouns: 'he/him',
      bio: 'Short books, long conversations. Currently re-reading **Piranesi** and drinking too much tea.',
      status: { emoji: token('sunny'), text: 'Reading in the garden', duration: 'today' },
    });
    await api.ada.request('PATCH', '/api/me/profile', {
      bannerColor: 0x2da58e,
      accentColor: 0x2da58e,
      pronouns: 'she/her',
      bio: 'Organizer of the book club. Ask me about the reading list.',
      status: { emoji: '📚', text: 'Choosing the next book', duration: '4h' },
    });
    await api.grace.request('PATCH', '/api/me/profile', {
      bannerColor: 0xd264b6,
      status: { emoji: token('leafy'), text: 'Back at 3', duration: '1h' },
    });

    await api.ada.send(channels.general, `Welcome back everyone ${token('party_blob')}`);
    await api.grace.send(
      channels.general,
      `${token('heart_box')} ${token('leafy')} ${token('sunny')}`,
    );
    const last = await api.linus.send(channels.general, `Tea is ready ${token('moon')}`);
    await api.ada.react(last.id, token('party_blob'));
    await api.grace.react(last.id, token('party_blob'));
    await api.linus.react(last.id, token('leafy'));
  });

  test('desktop profile popover, editor, status menu, emoji, picker and perks', async ({
    browser,
  }) => {
    const popover = await visit(browser, ada, DESKTOP, general());
    await settle(popover.page);
    await popover.page.locator('.message-author', { hasText: 'Linus' }).first().click();
    await popover.page.locator('[data-harmony="profile-card"]').waitFor();
    await popover.page.getByText('Reading in the garden').waitFor();
    await popover.page.waitForTimeout(500);
    await popover.page.screenshot({ path: shot('desktop-profile-popover') });
    await popover.context.close();

    const chat = await visit(browser, ada, DESKTOP, general());
    await settle(chat.page);
    await chat.page
      .getByRole('list', { name: 'Messages' })
      .evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await chat.page.waitForTimeout(600);
    await chat.page.screenshot({ path: shot('desktop-custom-emoji') });

    const tea = chat.page.locator('.message', { hasText: 'Tea is ready' });
    await tea.hover();
    await tea.getByRole('button', { name: 'Add reaction' }).first().click();
    await chat.page.locator('.emoji-section').first().waitFor();
    await chat.page.waitForTimeout(400);
    await chat.page.screenshot({ path: shot('desktop-emoji-picker-custom') });
    await chat.page.keyboard.press('Escape');

    await chat.page.getByRole('button', { name: /Status:/ }).click();
    await chat.page.getByRole('menuitem', { name: 'Set a custom status' }).waitFor();
    await chat.page.waitForTimeout(300);
    await chat.page.screenshot({ path: shot('desktop-status-menu') });
    await chat.context.close();

    const editor = await visit(browser, ada, DESKTOP, '/settings/user/profile');
    await editor.page.getByRole('heading', { level: 1, name: 'Profile' }).waitFor();
    await editor.page.getByText('About me').waitFor();
    await editor.page.waitForTimeout(500);
    await editor.page.screenshot({ path: shot('desktop-profile-editor') });
    await editor.context.close();

    const emoji = await visit(browser, ada, DESKTOP, `/settings/server/${seeded.guildId}/emoji`);
    await emoji.page.getByRole('textbox', { name: 'Name of party_blob' }).waitFor();
    await emoji.page.waitForTimeout(500);
    await emoji.page.screenshot({ path: shot('desktop-emoji-settings') });
    await emoji.context.close();

    const perks = await visit(browser, ada, DESKTOP, '/settings/user/perks');
    await perks.page.getByRole('table', { name: 'Perks by person' }).waitFor();
    await perks.page.waitForTimeout(500);
    await perks.page.screenshot({ path: shot('desktop-perks-admin') });
    await perks.context.close();
  });

  test('mobile profile sheet and editor', async ({ browser }) => {
    const phone = await visit(browser, ada, PHONE, general());
    await settle(phone.page);
    await phone.page.locator('.message-author', { hasText: 'Linus' }).first().tap();
    await phone.page.locator('[data-harmony="profile-card"]').waitFor();
    await phone.page.getByText('Reading in the garden').waitFor();
    await phone.page.waitForTimeout(600);
    await phone.page.screenshot({ path: shot('mobile-profile-sheet') });
    await phone.context.close();

    const editor = await visit(browser, ada, PHONE, '/settings/user/profile');
    await editor.page.getByRole('heading', { level: 1, name: 'Profile' }).waitFor();
    await editor.page.getByText('About me').waitFor();
    await editor.page.waitForTimeout(500);
    await editor.page.screenshot({ path: shot('mobile-profile-editor') });
    await editor.context.close();
  });
});

test.describe('dashboards', () => {
  let stop: () => void = () => undefined;

  test.afterAll(() => stop());

  test('a dashboard channel with a live chart, stats and buttons', async ({ browser }) => {
    const { ada } = seeded.api;
    const guild = await ada.createGuild('Home Lab Ops');
    const channel = await ada.createChannel(guild.id, 'host-health', {
      topic: 'Published by the dashboard example bot',
      kind: 'dashboard',
    });
    const port = await freePort();
    const created = await ada.createBot({
      name: 'Ops',
      scopes: ['messages.read', 'messages.write', 'commands', 'panels.write'],
      interactionsUrl: `http://127.0.0.1:${String(port)}/interactions`,
    });
    await ada.addBotToGuild(guild.id, created.bot.id);
    const bot = await startEchoBot({
      HARMONY_URL: new URL(baseURL).origin,
      HARMONY_BOT_TOKEN: created.token,
      HARMONY_SIGNING_SECRET: created.signingSecret,
      HARMONY_GUILD_ID: guild.id,
      HARMONY_DASHBOARD_CHANNEL_ID: channel.id,
      HARMONY_PANEL_INTERVAL_MS: '60000',
      PORT: String(port),
    });
    stop = () => bot.kill();

    for (const [prefix, options] of [
      ['desktop', DESKTOP],
      ['mobile', PHONE],
    ] as const) {
      const { context, page } = await visit(
        browser,
        'ada@example.com',
        options,
        `/channels/${guild.id}/${channel.id}`,
      );
      await page.getByRole('article', { name: 'Demo host' }).waitFor();
      await page.getByRole('img', { name: /^Load\./ }).waitFor();
      await page.evaluate(() => document.fonts.load('15px "Manrope Variable"'));
      await page.waitForTimeout(600);
      if (prefix === 'desktop') {
        await page.getByRole('img', { name: /^Load\./ }).hover({ position: { x: 640, y: 100 } });
        await page.waitForTimeout(200);
      }
      await page.screenshot({ path: shot(`${prefix}-dashboard`) });
      await context.close();
    }
  });
});

test.describe('agent hub', () => {
  let agent: ChildProcess | undefined;

  test.afterAll(() => agent?.kill());

  test('a run waiting on an approval, and the approval message', async ({ browser }) => {
    const build = spawnSync('pnpm', ['--filter', '@harmony/mcp', 'build'], { encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`mcp build failed: ${build.stdout}${build.stderr}`);
    const { ada } = seeded.api;
    const guild = await ada.createGuild('Release Desk');
    const dashboard = await ada.createChannel(guild.id, 'agents', { kind: 'dashboard' });
    const approvals = await ada.createChannel(guild.id, 'approvals');
    const created = await ada.createBot({
      name: 'Release agent',
      scopes: ['messages.read', 'messages.write', 'channels.read', 'panels.write', 'commands'],
    });
    await ada.addBotToGuild(guild.id, created.bot.id);
    agent = spawn(process.execPath, ['demo.ts'], {
      cwd: path.resolve('../../examples/agent-demo'),
      env: {
        ...process.env,
        HARMONY_URL: new URL(baseURL).origin,
        HARMONY_BOT_TOKEN: created.token,
        DEMO_DASHBOARD_CHANNEL: dashboard.id,
        DEMO_APPROVAL_CHANNEL: approvals.id,
        DEMO_PACE_MS: '1200',
        DEMO_APPROVAL_SECONDS: '600',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agent.stdout?.on('data', (chunk: Buffer) => console.log(`agent: ${chunk.toString().trim()}`));
    agent.stderr?.on('data', (chunk: Buffer) => console.log(`agent: ${chunk.toString().trim()}`));

    for (const [prefix, options] of [
      ['desktop', DESKTOP],
      ['mobile', PHONE],
    ] as const) {
      const run = await visit(
        browser,
        'ada@example.com',
        options,
        `/channels/${guild.id}/${dashboard.id}`,
      );
      const panel = run.page.getByRole('article', { name: 'Agent run: Release 2.4' });
      await expect(panel).toContainText('Waiting for approval', { timeout: 30_000 });
      await run.page.evaluate(() => document.fonts.load('15px "Manrope Variable"'));
      await run.page.waitForTimeout(400);
      await run.page.screenshot({ path: shot(`${prefix}-agent-run`) });
      await run.context.close();

      const chat = await visit(
        browser,
        'ada@example.com',
        options,
        `/channels/${guild.id}/${approvals.id}`,
      );
      await chat.page.getByRole('button', { name: 'Approve' }).waitFor();
      await chat.page.evaluate(() => document.fonts.load('15px "Manrope Variable"'));
      await chat.page.waitForTimeout(400);
      await chat.page.screenshot({ path: shot(`${prefix}-agent-approval`) });
      await chat.context.close();
    }
    // Leave nothing waiting: approve so the demo finishes.
    const page = (
      await ada.request<{ messages: { id: string }[] }>(
        'GET',
        `/api/channels/${approvals.id}/messages`,
      )
    ).messages[0];
    if (page) {
      await ada.request('POST', '/api/interactions/actions', {
        source: { messageId: page.id },
        actionId: 'approve',
      });
    }
  });
});
