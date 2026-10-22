import { expect, test } from '@playwright/test';
import { DevApi } from './support/dev-api.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';

test('a role with manage_messages lets a member delete others’ messages, and an overwrite hides a channel live', async ({
  browser,
}) => {
  const run = Date.now().toString(36);
  const ownerLogin = `owner-${run}@example.com`;
  const memberLogin = `member-${run}@example.com`;
  const owner = new DevApi(baseURL, ownerLogin);
  const member = new DevApi(baseURL, memberLogin);

  const guild = await owner.createGuild(`Roles ${run}`);
  await member.acceptInvite((await owner.createInvite(guild.id)).code);
  const general = (await owner.channels()).find((c) => c.guildId === guild.id && c.name === 'general');
  if (!general) throw new Error('general missing');
  const ideas = await owner.createChannel(guild.id, 'ideas');
  const memberId = (await member.me()).id;
  await owner.send(general.id, 'a message the member may not remove');

  const memberContext = await browser.newContext();
  await memberContext.addCookies([{ name: 'dev_login', value: memberLogin, url: baseURL }]);
  const memberPage = await memberContext.newPage();
  await memberPage.goto(`/channels/${guild.id}/${general.id}`);
  const message = memberPage.locator('.message', { hasText: 'a message the member may not remove' });
  await message.hover();
  await message.getByRole('button', { name: 'More actions' }).click();
  await expect(memberPage.getByRole('menuitem', { name: 'Copy text' })).toBeVisible();
  await expect(memberPage.getByRole('menuitem', { name: 'Delete message' })).toHaveCount(0);
  await memberPage.keyboard.press('Escape');
  // Members do not see the server settings entry either.
  await memberPage.getByRole('button', { name: `Roles ${run} menu` }).click();
  await expect(memberPage.getByRole('menuitem', { name: 'Server settings' })).toHaveCount(0);
  await memberPage.keyboard.press('Escape');

  // The owner makes the role in the settings UI and hands it over.
  const ownerContext = await browser.newContext();
  await ownerContext.addCookies([{ name: 'dev_login', value: ownerLogin, url: baseURL }]);
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto(`/settings/server/${guild.id}/roles`);
  await ownerPage.getByRole('button', { name: 'Create role' }).click();
  await ownerPage.getByLabel('Role name').fill('Janitor');
  await ownerPage.getByRole('tab', { name: 'Permissions' }).click();
  await ownerPage.getByRole('switch', { name: 'Manage messages' }).check();
  await ownerPage.getByRole('button', { name: 'Save changes' }).click();
  await ownerPage.getByRole('tab', { name: 'Members' }).click();
  await ownerPage.getByRole('listitem').filter({ hasText: `member-${run}` }).getByRole('button', { name: 'Add' }).click();

  // No reload: the role arrives over the socket and the menu entry appears.
  await expect(async () => {
    await message.hover();
    await message.getByRole('button', { name: 'More actions' }).click();
    await expect(memberPage.getByRole('menuitem', { name: 'Delete message' })).toBeVisible({
      timeout: 1000,
    });
  }).toPass();
  await memberPage.getByRole('menuitem', { name: 'Delete message' }).click();
  await memberPage.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(memberPage.getByText('Message deleted')).toBeVisible();

  // A channel overwrite hides the channel from the member without a reload.
  await expect(memberPage.getByRole('link', { name: 'ideas' })).toBeVisible();
  const everyone = (await owner.roles(guild.id)).find((r) => r.isDefault);
  if (!everyone) throw new Error('@everyone missing');
  await owner.putOverwrite(ideas.id, 'role', everyone.id, { deny: ['view_channel'] });
  await expect(memberPage.getByRole('link', { name: 'ideas' })).toHaveCount(0);
  await owner.putOverwrite(ideas.id, 'member', memberId, { allow: ['view_channel'] });
  await expect(memberPage.getByRole('link', { name: 'ideas' })).toBeVisible();

  await Promise.all([ownerContext.close(), memberContext.close()]);
});
