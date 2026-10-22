// Rasterizes public/icon.svg into the PNG sizes the manifest and iOS need.
// Run inside the Playwright image: see the README's "Screenshots and icons" notes.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
const bleed = svg.replace(/rx="112"/, 'rx="0"');
const jobs = [
  ['icon-192.png', 192, svg],
  ['icon-512.png', 512, svg],
  ['apple-touch-icon.png', 180, bleed],
  ['icon-maskable-512.png', 512, bleed],
];

const browser = await chromium.launch();
for (const [name, size, markup] of jobs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
  );
  await page.screenshot({
    path: new URL(`../public/${name}`, import.meta.url).pathname,
    omitBackground: true,
  });
  await page.close();
}
await browser.close();
