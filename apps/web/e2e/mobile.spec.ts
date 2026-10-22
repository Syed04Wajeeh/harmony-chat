import { expect, test } from '@playwright/test';
import { DevApi } from './support/dev-api.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';

test('the drawer opens from the hamburger and switches channel', async ({ browser }) => {
  const run = Date.now().toString(36);
  const login = `phone-${run}@example.com`;
  const api = new DevApi(baseURL, login);
  const [guild] = await api.guilds();
  if (!guild) throw new Error('expected the default server');
  const channel = await api.createChannel(guild.id, `drawer-${run}`);

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: /^Message #/ })).toBeVisible();

  const drawer = page.locator('.drawer-left');
  await expect(drawer).toHaveJSProperty('inert', true);
  await page.getByRole('button', { name: 'Open navigation' }).tap();
  await expect(drawer).toHaveJSProperty('inert', false);

  await drawer.getByRole('link', { name: new RegExp(`drawer-${run}`) }).tap();
  await expect(page).toHaveURL(new RegExp(`/channels/${guild.id}/${channel.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: `drawer-${run}` })).toBeVisible();
  await expect(drawer).toHaveJSProperty('inert', true);
  await context.close();
});

test('swiping from the left edge opens the drawer', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addCookies([
    { name: 'dev_login', value: `swipe-${Date.now().toString(36)}@example.com`, url: baseURL },
  ]);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: /^Message #/ })).toBeVisible();

  const cdp = await context.newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await touch('touchStart', 4, 400);
  for (const x of [30, 80, 140, 200, 260]) await touch('touchMove', x, 404);
  await touch('touchEnd', 260, 404);

  await expect(page.locator('.drawer-left')).toHaveJSProperty('inert', false);
  await context.close();
});

test('long-pressing a message opens the action sheet and replying works', async ({ browser }) => {
  const run = Date.now().toString(36);
  const login = `press-${run}@example.com`;
  const api = new DevApi(baseURL, login);
  const [guild] = await api.guilds();
  if (!guild) throw new Error('expected the default server');
  const channel = await api.createChannel(guild.id, `press-${run}`);
  await api.send(channel.id, `hold me ${run}`);

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  const page = await context.newPage();
  await page.goto(`/channels/${guild.id}/${channel.id}`);
  const message = page.getByText(`hold me ${run}`);
  await expect(message).toBeVisible();

  const box = await message.boundingBox();
  if (!box) throw new Error('message not visible');
  const cdp = await context.newCDPSession(page);
  const point = { x: box.x + 20, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  const sheet = page.getByRole('dialog', { name: 'Message actions' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Reply' }).tap();
  await expect(page.getByText('Replying to')).toBeVisible();

  // Enter inserts a newline on touch devices; the send button sends.
  const input = page.getByRole('textbox', { name: /^Message #/ });
  await input.fill('line one');
  await input.press('Enter');
  await expect(input).toHaveValue('line one\n');
  await input.pressSequentially('line two');
  await page.getByRole('button', { name: 'Send message' }).tap();
  await expect(page.getByText('line two')).toBeVisible();
  await context.close();
});
