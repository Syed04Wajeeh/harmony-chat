// Screenshots of the dashboard for a visual check, against the dev stack with Vite on 15173:
//   node tests/stack/screenshots.ts [output directory]
// Needs Playwright's Chromium (see the web app's e2e setup).
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { startStack, until } from './harness.ts';

const out = resolve(process.argv[2] ?? '/tmp/harmony-shots-homelab');
mkdirSync(out, { recursive: true });
const site = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:15173';

const stack = await startStack();
const browser = await chromium.launch();
try {
  // Let the game server change state once so the panel shows both kinds of button.
  await until('the first refresh', () => Promise.resolve(stack.botOutput().includes('connected')));
  const shoot = async (
    name: string,
    viewport: { width: number; height: number },
    mobile: boolean,
    dark: boolean,
  ) => {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: mobile ? 2 : 1,
      isMobile: mobile,
      hasTouch: mobile,
      colorScheme: dark ? 'dark' : 'light',
    });
    await context.addCookies([{ name: 'dev_login', value: stack.admin.login, url: site }]);
    const page = await context.newPage();
    await page.goto(`${site}/channels/${stack.guildId}/${stack.dashboardId}`);
    const containers = page.getByRole('article', { name: 'Containers' });
    await containers.waitFor();
    await page.getByRole('article', { name: 'Game servers' }).waitFor();
    await page.locator('.dashboard-scroll').evaluate('(el) => el.scrollTo(0, 0)');
    await page.screenshot({ path: `${out}/${name}-dashboard.png` });
    // The confirm dialog every control button opens.
    await containers.getByRole('button', { name: `Restart ${stack.throwaway.control}` }).click();
    await page.getByRole('alertdialog').waitFor();
    await page.waitForTimeout(500); // the dialog fades in
    await page.screenshot({ path: `${out}/${name}-confirm.png` });
    await page.getByRole('button', { name: 'Cancel' }).click();
    if (mobile) {
      await page
        .getByRole('button', { name: /Mock Keeper$/ })
        .last()
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/${name}-bottom.png` });
      const overflow = await page.evaluate<number>(
        '(document.documentElement.scrollWidth - document.documentElement.clientWidth)',
      );
      console.log(`${name}: horizontal overflow ${String(overflow)} px`);
    }
    await context.close();
  };
  await shoot('desktop', { width: 1280, height: 800 }, false, false);
  await shoot('desktop-dark', { width: 1280, height: 800 }, false, true);
  await shoot('mobile', { width: 390, height: 844 }, true, true);
  console.log(`screenshots in ${out}`);
} finally {
  await browser.close();
  stack.cleanup();
}
