import { expect, test } from '@playwright/test';
import { DevApi } from './support/dev-api.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';

test('settings drill down on a phone and slash commands open a touch-sized list', async ({
  browser,
}) => {
  const run = Date.now().toString(36);
  const login = `phone-bots-${run}@example.com`;
  const api = new DevApi(baseURL, login);
  const guild = await api.createGuild(`Phone ${run}`);
  const channel = (await api.channels()).find(
    (c) => c.guildId === guild.id && c.name === 'general',
  );
  if (!channel) throw new Error('general channel missing');

  // A bot with the commands scope registers one command with two options, as a bot would.
  const { bot, token } = await api.createBot({
    name: `Dice ${run}`,
    scopes: ['messages.read', 'messages.write', 'commands'],
  });
  await api.addBotToGuild(guild.id, bot.id);
  const registered = await fetch(`${baseURL}/api/bots/${bot.id}/guilds/${guild.id}/commands`, {
    method: 'PUT',
    headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify([
      {
        name: 'roll',
        description: 'Roll a die',
        options: [
          { name: 'sides', description: 'Number of sides', type: 'integer', required: true },
          { name: 'secret', description: 'Hide the result', type: 'boolean' },
        ],
      },
    ]),
  });
  expect(registered.status).toBe(200);

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  const page = await context.newPage();
  await page.goto(`/channels/${guild.id}/${channel.id}`);
  const box = page.getByRole('textbox', { name: /^Message #/ });
  await expect(box).toBeVisible();

  // Slash command list: bottom-anchored, with large touch targets.
  await box.fill('/');
  const option = page.getByRole('option', { name: /\/roll/ });
  await expect(option).toBeVisible();
  expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(56);
  await option.tap();
  await expect(page.getByRole('button', { name: 'Cancel /roll' })).toBeVisible();
  // Types are checked before sending.
  await page.getByRole('textbox', { name: 'sides' }).fill('many');
  await page.getByRole('button', { name: 'Run command' }).tap();
  await expect(page.getByRole('alert').filter({ hasText: 'whole number' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel /roll' }).tap();

  // User settings: a list of sections, then a page with a back arrow.
  await page.getByRole('button', { name: 'Open navigation' }).tap();
  await page.getByRole('link', { name: 'User settings' }).tap();
  await expect(page.getByRole('heading', { level: 1, name: 'User settings' })).toBeVisible();
  await page.getByRole('link', { name: 'My bots' }).tap();
  await expect(page.getByRole('heading', { level: 1, name: 'My bots' })).toBeVisible();
  await page.getByRole('link', { name: `Dice ${run}` }).tap();
  await expect(page.getByRole('heading', { level: 1, name: `Dice ${run}` })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Registered commands' })).toBeVisible();
  await expect(page.getByText('/roll')).toBeVisible();
  await page.getByRole('link', { name: 'Back' }).tap();
  await expect(page.getByRole('heading', { level: 1, name: 'My bots' })).toBeVisible();
  await page.getByRole('button', { name: 'Close settings' }).tap();
  await expect(page.getByRole('textbox', { name: /^Message #/ })).toBeVisible();
  await context.close();
});
