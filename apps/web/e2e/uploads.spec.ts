import { expect, test } from '@playwright/test';
import { scenePng } from './support/png.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';

test('uploading an image shows a preview in the message', async ({ browser }) => {
  const run = Date.now().toString(36);
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'dev_login', value: `uploader-${Date.now().toString(36)}@example.com`, url: baseURL },
  ]);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: /^Message #/ })).toBeVisible();

  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: `sunset-${run}.png`,
      mimeType: 'image/png',
      buffer: scenePng(640, 400),
    });
  const chip = page.getByRole('list', { name: 'Attachments' }).getByText(`sunset-${run}.png`);
  await expect(chip).toBeVisible();

  const send = page.getByRole('button', { name: 'Send message' });
  await expect(send).toBeEnabled();
  await send.click();

  const image = page
    .getByRole('list', { name: 'Messages' })
    .getByRole('img', { name: `sunset-${run}.png` });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640);

  // Tapping the preview opens the lightbox.
  await image.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await context.close();
});
