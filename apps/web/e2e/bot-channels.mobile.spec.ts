import { expect, test } from '@playwright/test';
import path from 'node:path';
import { DevApi } from './support/dev-api.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const origin = new URL(baseURL).origin;
const shotsDir = process.env['BOT_CHANNELS_SHOTS_DIR'];
const shot = (name: string) => (shotsDir ? { path: path.join(shotsDir, name) } : {});

test('bot channel settings and a feed channel fit a phone', async ({ browser }) => {
  const run = Date.now().toString(36);
  const owner = `phone-feed-${run}@example.com`;
  const member = `phone-member-${run}@example.com`;
  const api = new DevApi(baseURL, owner);
  const guild = await api.createGuild(`Phone feeds ${run}`);
  const channel = (await api.channels()).find(
    (c) => c.guildId === guild.id && c.name === 'general',
  );
  if (!channel) throw new Error('general channel missing');
  await new DevApi(baseURL, member).acceptInvite((await api.createInvite(guild.id)).code);

  // A gateway-style bot (no URL): it registers a schedule over the API and posts as itself.
  const botName = `Pager ${run}`;
  const { bot, token } = await api.createBot({
    name: botName,
    scopes: ['messages.read', 'messages.write', 'commands'],
  });
  await api.addBotToGuild(guild.id, bot.id);
  const registered = await fetch(`${origin}/api/bots/@me/schedules`, {
    method: 'PUT',
    headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      schedules: [
        { id: 'status-board', channelId: channel.id, every: 300, panelKey: 'status' },
        { id: 'weekly-digest', channelId: channel.id, cron: '0 9 * * 1' },
      ],
    }),
  });
  expect(registered.status).toBe(200);

  const viewport = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  const ownerContext = await browser.newContext(viewport);
  await ownerContext.addCookies([{ name: 'dev_login', value: owner, url: baseURL }]);
  const page = await ownerContext.newPage();
  await page.goto(`/channels/${guild.id}/${channel.id}`);
  await page.getByRole('button', { name: 'Channel settings' }).click();
  const dialog = page.getByRole('dialog', { name: '#general settings' });
  await dialog.getByRole('tab', { name: 'Bots' }).click();
  await dialog.getByRole('switch', { name: `Assign ${botName}` }).click();
  await dialog.getByRole('switch', { name: 'Bot feed' }).click();
  await expect(dialog.getByRole('switch', { name: `Assign ${botName}` })).toBeChecked();
  await expect(dialog.getByRole('switch', { name: 'Bot feed' })).toBeChecked();
  await expect(dialog.getByRole('listitem').filter({ hasText: 'weekly-digest' })).toContainText(
    'cron 0 9 * * 1 (UTC)',
  );
  await expect(dialog.getByRole('listitem').filter({ hasText: 'status-board' })).toContainText(
    'every 5 min',
  );
  await page.screenshot(shot('settings-bots-mobile.png'));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await ownerContext.close();

  const memberContext = await browser.newContext(viewport);
  await memberContext.addCookies([{ name: 'dev_login', value: member, url: baseURL }]);
  const mobile = await memberContext.newPage();
  await mobile.goto(`/channels/${guild.id}/${channel.id}`);
  await expect(mobile.getByText(/This channel is a bot feed/)).toBeVisible();
  await expect(mobile.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(mobile.getByRole('list', { name: 'Bots in this channel' })).toBeVisible();
  await mobile.screenshot(shot('feed-channel-mobile.png'));
  const memberOverflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(memberOverflow).toBeLessThanOrEqual(0);
  await memberContext.close();
});
