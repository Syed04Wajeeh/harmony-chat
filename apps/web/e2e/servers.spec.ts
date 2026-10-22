import { expect, test } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';

test('create a server and a private channel, invite someone, accept the invite', async ({
  browser,
}) => {
  const run = Date.now().toString(36);
  const owner = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await owner.addCookies([{ name: 'dev_login', value: `owner-${run}@example.com`, url: baseURL }]);
  const page = await owner.newPage();
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: /^Message #/ })).toBeVisible();

  await page.getByRole('button', { name: 'Create a server' }).click();
  await page.getByLabel('Server name').fill(`Club ${run}`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: `Club ${run} menu` })).toBeVisible();

  await page.getByRole('button', { name: 'Create channel' }).first().click();
  await page.getByLabel('Channel name').fill('secret-plans');
  await page.getByRole('switch', { name: /Private channel/ }).check();
  await page.getByRole('button', { name: 'Create channel' }).last().click();
  await expect(page.getByRole('heading', { level: 1, name: 'secret-plans' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add people to channel' })).toBeVisible();

  await page.getByRole('button', { name: `Club ${run} menu` }).click();
  await page.getByRole('menuitem', { name: 'Invite people' }).click();
  const link = page.getByRole('textbox', { name: 'Invite link' });
  await expect(link).toHaveValue(/\/invite\/[\w-]{10}$/);
  const url = await link.inputValue();
  await page.keyboard.press('Escape');

  const guest = await browser.newContext();
  await guest.addCookies([{ name: 'dev_login', value: `guest-${run}@example.com`, url: baseURL }]);
  const guestPage = await guest.newPage();
  await guestPage.goto(new URL(url).pathname);
  await expect(guestPage.getByRole('heading', { name: `Club ${run}` })).toBeVisible();
  await guestPage.getByRole('button', { name: 'Accept invite' }).click();
  await expect(guestPage.getByRole('button', { name: `Club ${run} menu` })).toBeVisible();
  // The private channel stays hidden from the new member.
  await expect(guestPage.getByRole('link', { name: 'secret-plans' })).toHaveCount(0);
  await expect(guestPage.getByRole('link', { name: 'general' })).toBeVisible();

  // The owner's member list for the private channel lists only the owner.
  await expect(
    page.getByRole('complementary', { name: 'Members' }).getByRole('button'),
  ).toHaveCount(1);
  await Promise.all([owner.close(), guest.close()]);
});
