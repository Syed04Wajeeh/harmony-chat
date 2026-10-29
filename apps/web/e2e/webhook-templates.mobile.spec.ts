import { expect, test } from '@playwright/test';
import { DevApi } from './support/dev-api.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const shots = process.env['E2E_SHOTS_DIR'];

test('the webhook editor fits a phone and previews a template', async ({ browser }) => {
  const run = Date.now().toString(36);
  const login = `phone-hooks-${run}@example.com`;
  const api = new DevApi(baseURL, login);
  const guild = await api.createGuild(`Phone hooks ${run}`);
  const channel = (await api.channels()).find(
    (c) => c.guildId === guild.id && c.name === 'general',
  );
  if (!channel) throw new Error('general channel missing');
  await api.request('POST', `/api/channels/${channel.id}/webhooks`, {
    name: 'Backups',
    format: 'template',
    template: {
      content: 'Backup {{status | upper}}',
      embed: {
        title: '{{name}}',
        fields: [{ name: 'Host', value: '{{host.name}}', inline: true }],
      },
    },
  });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  const page = await context.newPage();
  await page.goto(`/settings/server/${guild.id}/integrations`);
  await page.getByRole('button', { name: 'Edit webhook Backups' }).click();
  const editor = page.getByRole('dialog', { name: 'Settings for Backups' });
  await editor
    .getByLabel('Sample payload (JSON)')
    .fill('{"name":"Nightly","status":"ok","host":{"name":"nas"}}');
  await expect(editor.getByTestId('webhook-preview-message')).toContainText('Backup OK');
  await expect(editor.getByTestId('webhook-preview-message')).toContainText('Nightly');

  // Nothing pokes out sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await editor.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  if (shots) await page.screenshot({ path: `${shots}/editor-390.png` });
  await context.close();
});
