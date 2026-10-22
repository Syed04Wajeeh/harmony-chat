import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { DevApi } from './support/dev-api.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const apiURL = baseURL;

const sign = async (browser: Browser, login: string): Promise<[BrowserContext, Page]> => {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  return [context, await context.newPage()];
};

const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => document.documentElement.style.getPropertyValue(n), name);

test('a preset is applied, persisted across reloads and reaches a second session live', async ({
  browser,
}) => {
  const login = `themer-${Date.now().toString(36)}@example.com`;
  const [first, page] = await sign(browser, login);
  const [second, other] = await sign(browser, login);
  await other.goto('/');
  await expect(other.getByRole('textbox', { name: /^Message #/ })).toBeVisible();

  await page.goto('/settings/user/themes');
  await page.getByRole('button', { name: 'Use Midnight' }).click();
  await expect(page.getByRole('button', { name: 'Using Midnight' })).toBeVisible();
  await expect.poll(() => rootVar(page, '--color-bg-canvas')).toBe('#0a0e17');

  // The second browser context receives settings.updated and repaints without a reload.
  await expect.poll(() => rootVar(other, '--color-bg-canvas')).toBe('#0a0e17');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Using Midnight' })).toBeVisible();
  expect(await rootVar(page, '--color-bg-canvas')).toBe('#0a0e17');

  const [third, fresh] = await sign(browser, login);
  await fresh.goto('/');
  await expect.poll(() => rootVar(fresh, '--color-bg-canvas')).toBe('#0a0e17');
  await Promise.all([first.close(), second.close(), third.close()]);
});

test('the theme editor warns about a bad combination and auto-fixes it', async ({ browser }) => {
  const [context, page] = await sign(browser, `editor-${Date.now().toString(36)}@example.com`);
  await page.goto('/settings/user/themes/new?from=harmony-dark');
  await expect(page.getByText('Every pair reaches AA.')).toBeVisible();

  await page.getByRole('textbox', { name: 'Muted value' }).fill('#2f2e2b');
  await expect(page.locator('[data-contrast="muted"]')).toHaveAttribute('data-level', 'fail');
  await expect(page.getByText(/below AA and may be hard to read/)).toBeVisible();

  await page.getByRole('button', { name: 'Auto-fix' }).click();
  await expect(page.getByText('Every pair reaches AA.')).toBeVisible();
  await expect(page.locator('[data-contrast="muted"]')).not.toHaveAttribute('data-level', 'fail');

  await page.getByRole('textbox', { name: 'Name' }).fill('Night owl');
  await page.getByRole('button', { name: 'Save and use' }).click();
  await expect(page).toHaveURL(/\/settings\/user\/themes\/[0-9a-f-]{36}$/);
  await page.goto('/settings/user/themes');
  await expect(page.getByRole('button', { name: 'Using Night owl' })).toBeVisible();
  await context.close();
});

test('custom CSS is applied, sanitized, and switched off by ?safe', async ({ browser }) => {
  const [context, page] = await sign(browser, `css-${Date.now().toString(36)}@example.com`);
  await page.goto('/settings/user/advanced');
  await page.getByRole('switch', { name: 'Apply my custom CSS' }).check();
  await page
    .getByLabel('Stylesheet')
    .fill(
      '@import url(https://evil.example/x.css);\n[data-harmony="sidebar"] { outline: 3px solid rgb(255, 0, 0); }',
    );
  await page.getByRole('button', { name: 'Save CSS' }).click();
  await expect(page.locator('#user-custom-css')).toHaveCount(1);
  await expect(page.locator('#user-custom-css')).not.toContainText('evil.example');

  await page.goto('/');
  const sidebar = page.locator('[data-harmony="sidebar"]');
  await expect(sidebar).toHaveCSS('outline-style', 'solid');

  await page.goto('/?safe');
  await expect(page.getByText(/Safe mode/)).toBeVisible();
  await expect(page.locator('#user-custom-css')).toHaveCount(0);
  await expect(page.locator('[data-harmony="sidebar"]')).not.toHaveCSS('outline-style', 'solid');
  await page.getByRole('button', { name: 'Exit' }).click();
  await expect(page.locator('#user-custom-css')).toHaveCount(1);
  await context.close();
});

test('a guild accent shows while that guild is open', async ({ browser }) => {
  const login = `accent-${Date.now().toString(36)}@example.com`;
  const api = new DevApi(apiURL, login);
  const plain = await api.createGuild('Plain Club');
  const tinted = await api.createGuild('Tinted Club');
  await api.request('PATCH', `/api/guilds/${tinted.id}`, {
    accentColor: 0xe879a8,
    description: 'Pink on purpose.',
  });

  const [context, page] = await sign(browser, login);
  await page.goto('/');
  await page.getByRole('link', { name: 'Plain Club' }).click();
  await expect(page.getByRole('button', { name: 'Plain Club menu' })).toBeVisible();
  expect(await rootVar(page, '--color-accent')).toBe('');

  await page.getByRole('link', { name: 'Tinted Club' }).click();
  await expect(page.getByRole('button', { name: 'Tinted Club menu' })).toBeVisible();
  await expect.poll(() => rootVar(page, '--color-accent')).toMatch(/^#/);

  await page.getByRole('link', { name: 'Plain Club' }).click();
  await expect.poll(() => rootVar(page, '--color-accent')).toBe('');
  expect(plain.id).not.toBe(tinted.id);
  await context.close();
});
