import { mkdirSync } from 'node:fs';
import { expect, test, type Browser } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const shots = process.env['E2E_SHOTS_DIR'];

async function openStatusMenu(
  browser: Browser,
  name: string,
  viewport: { width: number; height: number },
) {
  const login = `status-${name}-${Date.now().toString(36)}@example.com`;
  const context = await browser.newContext({ viewport });
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: /^Message #/ })).toBeVisible();
  if (viewport.width < 600) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Change status/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Online' })).toBeVisible();
  return { context, page };
}

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 390, height: 844 }],
] as const) {
  test(`every status in the menu shows its dot and the current one is marked (${name})`, async ({
    browser,
  }) => {
    const { context, page } = await openStatusMenu(browser, name, viewport);
    const dotColor = (label: string) =>
      page
        .getByRole('menuitem', { name: label })
        .locator('.status-dot')
        .evaluate((el) => {
          const style = getComputedStyle(el);
          return { background: style.backgroundColor, border: style.borderTopWidth };
        });

    for (const label of ['Online', 'Idle', 'Do not disturb']) {
      const dot = await dotColor(label);
      expect(dot.background, label).not.toBe('rgba(0, 0, 0, 0)');
    }
    // Invisible is a ring, drawn with a border instead of a fill.
    expect((await dotColor('Invisible')).border).not.toBe('0px');

    await expect(page.getByRole('menuitem', { name: 'Online' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(page.getByRole('menuitem', { name: 'Idle' })).not.toHaveAttribute('aria-current');
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: `${shots}/status-menu-${name}.png` });
    }

    await page.getByRole('menuitem', { name: 'Do not disturb' }).click();
    await page.getByRole('button', { name: /Change status/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Do not disturb' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await context.close();
  });
}
