import { test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { seedBookClub, type Seeded } from './support/seed.js';

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

async function visit(
  browser: Browser,
  login: string,
  options: Parameters<Browser['newContext']>[0],
  url: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  // The Playwright image's system-ui has no bold face; use one that does so shots match real devices.
  await context.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = ':root{--font-sans:"Liberation Sans",Arial,sans-serif}';
      document.head.append(style);
    });
  });
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
  await light.page.screenshot({ path: shot('mobile-light') });
  await light.context.close();

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
  await light.page.screenshot({ path: shot('desktop-light') });
  await light.context.close();

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
