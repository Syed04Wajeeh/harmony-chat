import { expect, test, type Page } from '@playwright/test';
import { DevApi } from './support/dev-api.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const shots = process.env['E2E_SHOTS_DIR'];

const template = {
  content: 'Backup {{status | upper}} on {{host.name}}',
  embed: {
    title: '{{name}}',
    description: '{{message | default:"No details"}}',
    color: '#2ecc71',
    fields: [{ name: 'Host', value: '{{host.name}}', inline: true }],
  },
};
const sample = {
  name: 'Nightly backup',
  status: 'ok',
  message: '12 GB in 4 min',
  host: { name: 'nas' },
};

async function openIntegrations(page: Page, guildName: string) {
  await page.getByRole('button', { name: `${guildName} menu` }).click();
  await page.getByRole('menuitem', { name: 'Server settings' }).click();
  await page
    .getByRole('navigation', { name: 'Server settings sections' })
    .getByRole('link', { name: 'Integrations' })
    .click();
}

test('a template webhook is configured in the UI, previewed live and posts a card', async ({
  browser,
}) => {
  const run = Date.now().toString(36);
  const login = `templater-${run}@example.com`;
  const api = new DevApi(baseURL, login);
  const guild = await api.createGuild(`Templates ${run}`);
  const channel = await api.createChannel(guild.id, 'backups');

  const context = await browser.newContext();
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  const page = await context.newPage();
  await page.goto(`/channels/${guild.id}/${channel.id}`);
  await expect(page.getByRole('textbox', { name: 'Message #backups' })).toBeVisible();

  await openIntegrations(page, guild.name);
  await page.getByRole('button', { name: 'Create webhook' }).click();
  await page.getByLabel('Channel').selectOption({ label: '#backups' });
  await page.getByLabel('Name').fill('Backups');
  await page.getByLabel('Format').selectOption({ label: 'Custom template' });
  await page.getByRole('button', { name: 'Create webhook' }).last().click();
  await expect(page.getByText("You won't see this again")).toBeVisible();
  const url = await page.getByLabel('Webhook URL').inputValue();
  await page.getByRole('button', { name: /I have saved it/ }).click();

  await page.getByRole('button', { name: 'Edit webhook Backups' }).click();
  const editor = page.getByRole('dialog', { name: 'Settings for Backups' });
  await expect(editor.getByLabel('Format')).toHaveValue('template');
  await editor.getByLabel('Template (JSON)').fill(JSON.stringify(template, null, 2));
  await editor.getByLabel('Sample payload (JSON)').fill(JSON.stringify(sample, null, 2));

  // The preview comes from the server's renderer, not a copy of it in the browser.
  const preview = editor.getByTestId('webhook-preview-message');
  await expect(preview).toContainText('Backup OK on nas');
  await expect(preview).toContainText('Nightly backup');
  await expect(preview).toContainText('12 GB in 4 min');
  if (shots) await page.screenshot({ path: `${shots}/editor-desktop.png` });

  // A bad filter is reported without saving, and Save stays disabled.
  await editor.getByLabel('Template (JSON)').fill(JSON.stringify({ content: '{{status | eval}}' }));
  await expect(editor.getByRole('alert')).toContainText('unknown filter');
  await expect(editor.getByRole('button', { name: 'Save webhook' })).toBeDisabled();

  await editor.getByLabel('Template (JSON)').fill(JSON.stringify(template, null, 2));
  await expect(preview).toContainText('Backup OK on nas');
  await editor.getByRole('button', { name: 'Save webhook' }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Webhooks in backups' })).toContainText(
    'Custom template',
  );

  // The saved template is used for real.
  const response = await fetch(`${baseURL}${new URL(url).pathname}?wait=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sample),
  });
  expect(response.status).toBe(200);
  await page.keyboard.press('Escape');
  const card = page.locator('.embed', { hasText: 'Nightly backup' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('12 GB in 4 min');
  await expect(card).toContainText('Host');
  await expect(page.locator('li.message', { has: card })).toContainText('Backup OK on nas');

  // Switching to a signed preset asks for a secret and never shows it back.
  await openIntegrations(page, guild.name);
  await page.getByRole('button', { name: 'Edit webhook Backups' }).click();
  await editor.getByLabel('Format').selectOption({ label: 'GitHub' });
  await editor.getByLabel('Signing secret').fill('a-long-shared-secret');
  await expect(editor.getByTestId('webhook-preview-message')).toBeVisible();
  await editor.getByRole('button', { name: 'Save webhook' }).click();
  await expect(editor).toHaveCount(0);
  const unsigned = await fetch(`${baseURL}${new URL(url).pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'ping' },
    body: JSON.stringify({ zen: 'x', repository: { full_name: 'lab/harmony' } }),
  });
  expect(unsigned.status).toBe(401);
  await context.close();
});
