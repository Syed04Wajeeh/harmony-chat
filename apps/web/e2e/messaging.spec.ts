import { expect, test, type Browser, type BrowserContext } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';

async function asUser(browser: Browser, login: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  return context;
}

test('a message sent by one user appears for another in real time', async ({ browser }) => {
  const run = Date.now().toString(36);
  const [alice, bob] = await Promise.all([
    asUser(browser, `alice-${run}@example.com`),
    asUser(browser, `bob-${run}@example.com`),
  ]);
  const [pageA, pageB] = await Promise.all([alice.newPage(), bob.newPage()]);
  await Promise.all([pageA.goto('/'), pageB.goto('/')]);

  // Both land in the default server's first channel.
  await expect(pageA.getByRole('textbox', { name: /^Message #/ })).toBeVisible();
  await expect(pageB.getByRole('textbox', { name: /^Message #/ })).toBeVisible();
  await expect(pageA.getByText('Connecting…')).toBeHidden();
  await expect(pageB.getByText('Connecting…')).toBeHidden();

  const text = `hello from alice ${run}`;
  const box = pageA.getByRole('textbox', { name: /^Message #/ });
  await box.fill(text);
  await box.press('Enter');

  await expect(pageB.getByRole('list', { name: 'Messages' }).getByText(text)).toBeVisible();
  await expect(pageA.getByRole('list', { name: 'Messages' }).getByText(text)).toBeVisible();

  await Promise.all([alice.close(), bob.close()]);
});

test('reply, react, edit and delete work from the message toolbar', async ({ browser }) => {
  const run = Date.now().toString(36);
  const context = await asUser(browser, `editor-${run}@example.com`);
  const page = await context.newPage();
  await page.goto('/');
  const box = page.getByRole('textbox', { name: /^Message #/ });
  const list = page.getByRole('list', { name: 'Messages' });
  await expect(box).toBeVisible();

  await box.fill(`first ${run}`);
  await box.press('Enter');
  const byText = (text: string) =>
    list.locator('li.message').filter({ has: page.locator('.message-content', { hasText: text }) });
  const first = byText(`first ${run}`);
  await expect(first).toBeVisible();

  // Reply
  await first.hover();
  await first.getByRole('button', { name: 'Reply' }).click();
  await expect(page.getByText('Replying to')).toBeVisible();
  await box.fill(`second ${run}`);
  await box.press('Enter');
  const second = byText(`second ${run}`);
  await expect(second.getByRole('button', { name: new RegExp(`first ${run}`) })).toBeVisible();

  // React: toolbar picker, then toggle off by clicking the chip.
  await first.hover();
  await first.getByRole('button', { name: 'Add reaction' }).first().click();
  await page.getByRole('option', { name: 'thumbs up' }).click();
  const chip = first.getByRole('button', { name: /^👍 1/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(chip).toBeHidden();

  // Edit with the up arrow, which edits the last own message.
  await box.press('ArrowUp');
  const editor = page.getByRole('textbox', { name: 'Edit message' });
  await editor.fill(`second edited ${run}`);
  await editor.press('Enter');
  await expect(list.getByText(`second edited ${run}`)).toBeVisible();
  await expect(byText(`second edited ${run}`).getByText('(edited)')).toBeVisible();

  // Delete with confirmation
  const edited = byText(`second edited ${run}`);
  await edited.hover();
  await edited.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete message' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(list.getByText(`second edited ${run}`)).toBeHidden();
  await expect(list.getByText('Message deleted').first()).toBeVisible();
  await context.close();
});
