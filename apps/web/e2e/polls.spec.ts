import { expect, test, type Browser, type BrowserContext } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';

async function asUser(browser: Browser, login: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  return context;
}

test('a poll created by one person is voted on by another and the tally updates live', async ({
  browser,
}) => {
  const run = Date.now().toString(36);
  const [alice, bob] = await Promise.all([
    asUser(browser, `polls-alice-${run}@example.com`),
    asUser(browser, `polls-bob-${run}@example.com`),
  ]);
  const [pageA, pageB] = await Promise.all([alice.newPage(), bob.newPage()]);
  await Promise.all([pageA.goto('/'), pageB.goto('/')]);
  await expect(pageA.getByRole('textbox', { name: /^Message #/ })).toBeVisible();
  await expect(pageB.getByRole('textbox', { name: /^Message #/ })).toBeVisible();

  // Alice opens the composer menu and creates a poll in the dialog.
  await pageA.getByRole('button', { name: 'Add to message' }).click();
  await pageA.getByRole('menuitem', { name: 'Create poll' }).click();
  const dialog = pageA.getByRole('dialog', { name: 'Create a poll' });
  const question = `Where to eat ${run}?`;
  await dialog.getByLabel('Question').fill(question);
  await dialog.getByLabel('Option 1').fill('Pizza');
  await dialog.getByLabel('Option 2').fill('Ramen');
  await dialog.getByRole('button', { name: 'Create poll' }).click();

  const pollOn = (page: typeof pageA) =>
    page.locator('li.message').filter({ hasText: question }).getByRole('group', { name: 'Poll' });
  await expect(pollOn(pageA)).toBeVisible();
  await expect(pollOn(pageB)).toBeVisible();
  await expect(pollOn(pageB)).toContainText('0 people voted');

  // Bob votes; Alice sees the tally change without reloading.
  await pollOn(pageB).getByRole('button', { name: /Ramen/ }).click();
  await expect(pollOn(pageB).getByRole('button', { name: /Ramen/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(pollOn(pageA)).toContainText('1 person voted');
  await expect(pollOn(pageA).getByRole('button', { name: /Ramen/ })).toContainText('100%');
  await expect(pollOn(pageA).getByRole('button', { name: /Ramen/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // Only the author can close it.
  await expect(pollOn(pageB).getByRole('button', { name: 'Close poll' })).toHaveCount(0);
  await pollOn(pageA).getByRole('button', { name: 'Close poll' }).click();
  await expect(pollOn(pageB)).toContainText('Closed');
  await expect(pollOn(pageB).getByRole('button', { name: /Pizza/ })).toBeDisabled();

  await Promise.all([alice.close(), bob.close()]);
});

test('switching reactions off for a server hides the reaction controls', async ({ browser }) => {
  const run = Date.now().toString(36);
  const context = await asUser(browser, `modules-owner-${run}@example.com`);
  const page = await context.newPage();
  // Their own server, so they own it whatever else the database holds.
  await page.goto('/');
  const created = await page.request.post('/api/guilds', {
    data: { name: `Modules ${run}` },
    headers: { origin: baseURL },
  });
  expect(created.ok()).toBe(true);
  const guildId = ((await created.json()) as { id: string }).id;

  await page.goto(`/channels/${guildId}`);
  const box = page.getByRole('textbox', { name: /^Message #general/ });
  await expect(box).toBeVisible();
  await box.fill(`react to ${run}`);
  await box.press('Enter');
  const message = page.locator('li.message').filter({ hasText: `react to ${run}` });
  await message.hover();
  await expect(message.getByRole('button', { name: 'Add reaction' }).first()).toBeVisible();

  await page.goto(`/settings/server/${guildId}/modules`);
  const toggle = page.getByRole('switch', { name: 'Reactions enabled' });
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  await page.goto(`/channels/${guildId}`);
  const again = page.locator('li.message').filter({ hasText: `react to ${run}` });
  await again.hover();
  await expect(again).toBeVisible();
  await expect(again.getByRole('button', { name: 'Add reaction' })).toHaveCount(0);
  await context.close();
});
