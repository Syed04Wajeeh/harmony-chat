import { expect, test } from '@playwright/test';
import { DevApi } from './support/dev-api.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const shots = process.env['E2E_SHOTS_DIR'];

test('members tab and invite card fit a phone, and joining works from the card', async ({
  browser,
}) => {
  const run = Date.now().toString(36);
  const host = new DevApi(baseURL, `phonehost-${run}@example.com`);
  const guestLogin = `phoneguest-${run}@example.com`;
  const guestId = (await new DevApi(baseURL, guestLogin).me()).id;
  const guild = await host.createGuild(`Hike ${run}`);
  await host.request('POST', `/api/guilds/${guild.id}/invites/send`, { userIds: [guestId] });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addCookies([{ name: 'dev_login', value: guestLogin, url: baseURL }]);
  const page = await context.newPage();
  await page.goto('/channels/@me');

  // Has a conversation (the invite), so it opens on Messages; the directory is one tap away.
  await page.getByRole('tab', { name: 'All members' }).tap();
  await expect(page.locator('.directory-row').first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
  await page.getByRole('searchbox', { name: 'Search members' }).fill(`phonehost-${run}`);
  await expect(page.locator('.directory-row')).toHaveCount(1);
  if (shots) await page.screenshot({ path: `${shots}/members-mobile.png` });

  await page.getByRole('tab', { name: 'Messages' }).tap();
  await page
    .locator('.home-list')
    .getByRole('link', { name: new RegExp(`phonehost-${run}`, 'i') })
    .tap();
  const card = page.locator('[data-harmony="invite-embed"]');
  await expect(card).toContainText(`Hike ${run}`);
  if (shots) await page.screenshot({ path: `${shots}/invite-card-mobile.png` });
  const box = await card.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  await card.getByRole('button', { name: 'Join' }).tap();
  await expect(card.getByText('Joined')).toBeVisible();
  await context.close();
});
