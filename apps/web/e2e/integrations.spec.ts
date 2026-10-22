import { expect, test, type Page } from '@playwright/test';
import { DevApi } from './support/dev-api.js';
import { freePort, startEchoBot } from './support/echo-bot.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';

async function signedInAs(page: Page, login: string) {
  await page.context().addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
}

async function openServerSettings(page: Page, guildName: string, section: string) {
  await page.getByRole('button', { name: `${guildName} menu` }).click();
  await page.getByRole('menuitem', { name: 'Server settings' }).click();
  await page
    .getByRole('navigation', { name: 'Server settings sections' })
    .getByRole('link', { name: section })
    .click();
}

// The first user in an empty database is the instance admin, which bots need to reach localhost.
// This file sorts before the other specs so its first test creates that user.
test('a bot made in the UI answers slash commands through the echo example', async ({
  browser,
}) => {
  const run = Date.now().toString(36);
  const login = 'botowner@example.com';
  const api = new DevApi(baseURL, login);
  const me = await api.me();
  test.skip(!me.isAdmin, `needs an empty database: ${me.displayName} is not an instance admin`);

  const guild = await api.createGuild(`Bots ${run}`);
  const channel = (await api.channels()).find(
    (c) => c.guildId === guild.id && c.name === 'general',
  );
  if (!channel) throw new Error('general channel missing');

  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await signedInAs(page, login);
  await page.goto(`/channels/${guild.id}/${channel.id}`);
  await expect(page.getByRole('textbox', { name: /^Message #/ })).toBeVisible();

  // Create the bot and keep the credentials that are shown once.
  await page.getByRole('link', { name: 'User settings' }).click();
  await page.getByRole('link', { name: 'My bots' }).click();
  await page.getByRole('button', { name: 'Create bot' }).click();
  await page.getByLabel('Bot name').fill(`Echo ${run}`);
  await page.getByRole('button', { name: 'Create bot' }).last().click();
  await expect(page.getByText("You won't see this again").first()).toBeVisible();
  const token = await page.getByLabel('Bot token').inputValue();
  const secret = await page.getByLabel('Signing secret').inputValue();
  expect(token).toMatch(/^hb_\d+_/);
  await page.getByRole('button', { name: /I have saved these/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Echo ${run}` })).toBeVisible();

  // A URL pointing at a private address is refused with a readable message.
  await page.getByRole('checkbox', { name: /Slash commands/ }).check();
  await page
    .getByRole('textbox', { name: 'Interactions URL' })
    .fill('http://10.1.2.3/interactions');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('will not call that URL');

  const port = await freePort();
  await page
    .getByRole('textbox', { name: 'Interactions URL' })
    .fill(`http://127.0.0.1:${String(port)}/interactions`);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Bot saved')).toBeVisible();

  // Add it to the server.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: /^Message #/ })).toBeVisible();
  await openServerSettings(page, guild.name, 'Bots');
  await page.getByRole('button', { name: 'Add bot' }).click();
  await page.getByRole('button', { name: `Add Echo ${run}` }).click();
  await expect(page.getByRole('list', { name: 'Bots in this server' })).toContainText(
    `Echo ${run}`,
  );
  await page.keyboard.press('Escape');

  const bot = await startEchoBot({
    HARMONY_URL: new URL(baseURL).origin,
    HARMONY_BOT_TOKEN: token,
    HARMONY_SIGNING_SECRET: secret,
    HARMONY_GUILD_ID: guild.id,
    PORT: String(port),
  });
  try {
    const box = page.getByRole('textbox', { name: /^Message #/ });
    await box.fill('/');
    const list = page.getByRole('listbox', { name: 'Slash commands' });
    await expect(list.getByRole('option')).toHaveCount(2);
    await expect(list).toContainText('Repeat text back');
    await expect(list).toContainText(`Echo ${run}`);

    // Ephemeral reply: only this user sees it, and it is never stored.
    await list.getByRole('option', { name: /\/echo/ }).click();
    await page.getByRole('textbox', { name: 'text' }).fill('hello from the e2e');
    await page.getByRole('textbox', { name: 'text' }).press('Enter');
    const local = page.locator('li.message-local');
    await expect(local).toContainText('hello from the e2e');
    await expect(local).toContainText('Only you can see this');
    await local.getByRole('button', { name: 'Dismiss' }).click();
    await expect(local).toHaveCount(0);

    // Required options are checked before anything is sent.
    await box.fill('/');
    await list.getByRole('option', { name: /\/echo/ }).click();
    await page.getByRole('button', { name: 'Run command' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Required' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel /echo' }).click();

    // Deferred reply: a placeholder, then a normal message from the bot.
    await box.fill('/roll ');
    await page.getByRole('textbox', { name: 'sides' }).fill('6');
    await page.getByRole('textbox', { name: 'sides' }).press('Enter');
    await expect(page.getByText(`Echo ${run} is thinking…`)).toBeVisible();
    const messages = page.getByRole('list', { name: 'Messages' });
    await expect(messages.getByText(/You rolled a [1-6]/)).toBeVisible();
    await expect(page.getByText(/is thinking/)).toHaveCount(0);
    await expect(messages.locator('.author-badge', { hasText: 'BOT' }).first()).toBeVisible();
  } finally {
    bot.kill();
    await context.close();
  }
});

test('a webhook created in the UI posts a Discord embed that renders as a card', async ({
  browser,
}) => {
  const run = Date.now().toString(36);
  const login = `hooker-${run}@example.com`;
  const api = new DevApi(baseURL, login);
  const guild = await api.createGuild(`Alerts ${run}`);
  const alerts = await api.createChannel(guild.id, 'alerts');

  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await signedInAs(page, login);
  await page.goto(`/channels/${guild.id}/${alerts.id}`);
  await expect(page.getByRole('textbox', { name: 'Message #alerts' })).toBeVisible();

  await openServerSettings(page, guild.name, 'Integrations');
  await page.getByRole('button', { name: 'Create webhook' }).click();
  await page.getByLabel('Channel').selectOption({ label: '#alerts' });
  await page.getByLabel('Name').fill('Uptime Kuma');
  await page.getByRole('button', { name: 'Create webhook' }).last().click();

  await expect(page.getByText("You won't see this again")).toBeVisible();
  const url = await page.getByLabel('Webhook URL').inputValue();
  expect(url).toMatch(new RegExp(`^${new URL(baseURL).origin}/api/webhooks/\\d+/[\\w-]+$`));
  await page.getByRole('button', { name: 'Copy' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await page.getByRole('button', { name: /I have saved it/ }).click();
  await expect(page.getByRole('list', { name: 'Webhooks in alerts' })).toContainText('Uptime Kuma');

  // Post the way Uptime Kuma's Discord notification does.
  const response = await fetch(`${baseURL}${new URL(url).pathname}?wait=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'Uptime Kuma',
      embeds: [
        {
          title: '❌ Web server is down',
          description: 'Connection timed out',
          color: 15158332,
          timestamp: '2026-10-22 08:15:00.000',
          fields: [
            { name: 'Service Name', value: 'Web server', inline: true },
            { name: 'Service URL', value: 'https://example.com', inline: true },
            { name: 'Time (UTC)', value: '2026-10-22 08:15:00', inline: true },
          ],
          footer: { text: 'checked every 60s' },
        },
      ],
    }),
  });
  expect(response.status).toBe(200);

  await page.keyboard.press('Escape');
  const card = page.locator('.embed', { hasText: 'Web server is down' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Connection timed out');
  await expect(card).toContainText('Service Name');
  await expect(card.locator('.embed-field')).toHaveCount(3);
  // The color bar is the card's ::before, painted from the sender's color.
  await expect
    .poll(() => card.evaluate((el) => getComputedStyle(el, '::before').backgroundColor))
    .toBe('rgb(231, 76, 60)');
  const message = page.locator('li.message', { has: card });
  await expect(message.locator('.message-author')).toHaveText('Uptime Kuma');
  await expect(message.locator('.author-badge')).toHaveText('WEBHOOK');
  // Deleting the webhook needs a confirmation.
  await openServerSettings(page, guild.name, 'Integrations');
  await page.getByRole('button', { name: 'Delete webhook Uptime Kuma' }).click();
  await page.getByRole('button', { name: 'Delete webhook', exact: true }).click();
  await expect(page.getByText('No webhooks in this server yet.')).toBeVisible();
  const gone = await fetch(`${baseURL}${new URL(url).pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'still there?' }),
  });
  expect([401, 404]).toContain(gone.status);
  await context.close();
});
