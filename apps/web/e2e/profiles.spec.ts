import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { DevApi } from './support/dev-api.js';
import { makePng } from './support/png.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';
const unique = (name: string) => `${name}-${Date.now().toString(36)}@example.com`;

const sign = async (browser: Browser, login: string): Promise<[BrowserContext, Page]> => {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'dev_login', value: login, url: baseURL }]);
  return [context, await context.newPage()];
};

const square = (r: number, g: number, b: number) =>
  makePng(32, 32, (x, y) => ((x + y) % 8 < 4 ? [r, g, b] : [255 - r, 255 - g, 255 - b]));

// In an empty database the first user is the instance admin; make that the dev login.
test.beforeAll(async () => {
  await new DevApi(baseURL, 'dev@example.com').me();
});

async function instanceAdmin(): Promise<DevApi | null> {
  const candidate = new DevApi(baseURL, 'dev@example.com');
  const me = await candidate.request<{ isAdmin: boolean }>('GET', '/api/me');
  return me.isAdmin ? candidate : null;
}

test('editing a profile updates another user’s open popover live', async ({ browser }) => {
  const [alice, a] = await sign(browser, unique('alice'));
  const [bob, b] = await sign(browser, unique('bob'));
  await a.goto('/');
  await b.goto('/');
  await expect(a.getByRole('textbox', { name: /^Message #/ })).toBeVisible();
  await a.getByRole('textbox', { name: /^Message #/ }).fill('hello from alice');
  await a.keyboard.press('Enter');
  await b.locator('.message-author', { hasText: 'alice' }).first().click();
  const card = b.locator('[data-harmony="profile-card"]');
  await expect(card).toBeVisible();
  await expect(card.getByText('About me')).toHaveCount(0);

  await a.goto('/settings/user/profile');
  await a.getByLabel('Pronouns').fill('she/her');
  await a.getByLabel('Pronouns').blur();
  await a.locator('textarea').fill('Reads **too much**');
  await a.locator('textarea').blur();

  await expect(card.getByText('Reads')).toBeVisible();
  await expect(card.locator('strong')).toHaveText('too much');
  await expect(card.getByText('she/her')).toBeVisible();
  await Promise.all([alice.close(), bob.close()]);
});

test('an uploaded custom emoji works in a message and a reaction', async ({ browser }) => {
  const owner = new DevApi(baseURL, unique('owner'));
  const guild = await owner.createGuild('Emoji Test');
  const [context, page] = await sign(browser, owner.login);

  await page.goto(`/settings/server/${guild.id}/emoji`);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'square.png',
    mimeType: 'image/png',
    buffer: square(200, 60, 60),
  });
  await expect(page.getByRole('textbox', { name: 'Name of square' })).toBeVisible();

  await page.goto(`/channels/${guild.id}`);
  const composer = page.getByRole('textbox', { name: /^Message #/ });
  await composer.fill('look :squ');
  await page.getByRole('option', { name: /:square:/ }).click();
  await page.keyboard.press('Enter');
  const message = page.locator('.message-content', { hasText: 'look' }).last();
  await expect(message.locator('img.emoji')).toBeVisible();

  await message.hover();
  await page.getByRole('button', { name: 'Add reaction' }).first().click();
  await page.getByRole('button', { name: 'square', exact: true }).click();
  await expect(page.locator('.reaction img.emoji')).toBeVisible();
  await context.close();
});

test('revoking cross_server_emoji turns the emoji into text in another server', async ({
  browser,
}) => {
  const admin = await instanceAdmin();
  test.skip(admin === null, 'needs the instance admin (the first user in an empty database)');
  if (!admin) return;

  const owner = new DevApi(baseURL, unique('own'));
  const member = new DevApi(baseURL, unique('mem'));
  const memberId = (await member.me()).id;
  const home = await owner.createGuild('Home');
  const away = await owner.createGuild('Away');
  for (const guild of [home, away]) {
    await member.acceptInvite((await owner.createInvite(guild.id)).code);
  }
  const upload = await owner.upload('wave.png', square(60, 120, 200));
  const emoji = await owner.request<{ id: string }>('POST', `/api/guilds/${home.id}/emoji`, {
    name: 'wave',
    attachmentId: upload.id,
  });
  const awayChannel = (await owner.channels()).find((c) => c.guildId === away.id);
  if (!awayChannel) throw new Error('missing channel');
  const token = `<:wave:${emoji.id}>`;

  await admin.request('PUT', `/api/admin/users/${memberId}/perks`, { perk: 'cross_server_emoji' });
  await member.send(awayChannel.id, `granted ${token}`);
  await admin.request('DELETE', `/api/admin/users/${memberId}/perks/cross_server_emoji`);
  await member.send(awayChannel.id, `revoked ${token}`);

  const [context, page] = await sign(browser, owner.login);
  await page.goto(`/channels/${away.id}/${awayChannel.id}`);
  await expect(
    page.locator('.message-content', { hasText: 'granted' }).locator('img.emoji'),
  ).toBeVisible();
  const revoked = page.locator('.message-content', { hasText: 'revoked' });
  await expect(revoked).toContainText(':wave:');
  await expect(revoked.locator('img.emoji')).toHaveCount(0);
  await context.close();
});
