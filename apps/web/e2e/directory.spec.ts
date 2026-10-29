import { expect, test, type Browser } from '@playwright/test';
import { DevApi } from './support/dev-api.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const shots = process.env['E2E_SHOTS_DIR'];

async function visit(browser: Browser, login: string, path: string) {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  const page = await context.newPage();
  await page.goto(path);
  return { context, page };
}

test('new people can find anyone under All members, open their profile and message them', async ({
  browser,
}) => {
  const run = Date.now().toString(36);
  const friend = `friend-${run}@example.com`;
  await new DevApi(baseURL, friend).me();

  const { context, page } = await visit(browser, `viewer-${run}@example.com`, '/channels/@me');
  await expect(page.getByRole('tab', { name: 'All members' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const search = page.getByRole('searchbox', { name: 'Search members' });
  await search.fill(`friend-${run}`);
  const row = page.locator('.directory-row', { hasText: friend });
  await expect(row).toBeVisible();
  await expect(page.locator('.directory-row')).toHaveCount(1);
  if (shots) await page.screenshot({ path: `${shots}/members-search.png` });

  await row.getByRole('button', { name: `Profile of friend-${run}` }).click();
  await expect(page.locator('.profile-name', { hasText: `friend-${run}` })).toBeVisible();
  await page.keyboard.press('Escape');

  await row.getByRole('button', { name: `Message friend-${run}` }).click();
  await expect(page).toHaveURL(/\/channels\/@me\/\d+$/);
  await expect(page.getByRole('textbox', { name: /^Message / })).toBeVisible();
  await context.close();
});

test('invite people by picking them; the card arrives in their DM with a Join button', async ({
  browser,
}) => {
  const run = Date.now().toString(36);
  const owner = new DevApi(baseURL, `host-${run}@example.com`);
  const guest = `guest-${run}@example.com`;
  await new DevApi(baseURL, guest).me();
  const guild = await owner.createGuild(`Picnic ${run}`);

  const host = await visit(browser, `host-${run}@example.com`, `/channels/${guild.id}`);
  await host.page.getByRole('button', { name: `Picnic ${run} menu` }).click();
  await host.page.getByRole('menuitem', { name: 'Invite people' }).click();
  await expect(host.page.getByRole('textbox', { name: 'Invite link' })).toHaveValue(/\/invite\//);
  await host.page.getByRole('searchbox', { name: 'Search people to invite' }).fill(`guest-${run}`);
  await host.page.getByRole('checkbox', { name: new RegExp(`guest-${run}`, 'i') }).click();
  if (shots) await host.page.screenshot({ path: `${shots}/invite-dialog.png` });
  await host.page.getByRole('button', { name: 'Send invite' }).click();
  await expect(
    host.page.getByRole('status').filter({ hasText: 'Invite sent to 1 person' }),
  ).toBeVisible();

  const invited = await visit(browser, guest, '/channels/@me?tab=messages');
  await invited.page
    .getByRole('link', { name: new RegExp(`host-${run}`, 'i') })
    .first()
    .click();
  const card = invited.page.locator('[data-harmony="invite-embed"]');
  await expect(card).toContainText(`Picnic ${run}`);
  await expect(card).toContainText('1 member');
  if (shots) await invited.page.screenshot({ path: `${shots}/invite-card.png` });
  await card.getByRole('button', { name: 'Join' }).click();
  await expect(card.getByText('Joined')).toBeVisible();
  await card.getByRole('button', { name: 'Open' }).click();
  await expect(invited.page.getByRole('button', { name: `Picnic ${run} menu` })).toBeVisible();
  await Promise.all([host.context.close(), invited.context.close()]);
});
