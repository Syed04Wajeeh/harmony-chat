import type { PanelView } from '@harmony/shared';
import { describe, expect, it } from 'vitest';
import { HarmonyError } from '../src/client.js';
import { PanelSync } from '../src/panel-sync.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const view = (n: number): PanelView => ({
  blocks: [{ type: 'stat', label: 'n', value: n }],
});

function fakeApi(options: { limit?: number } = {}) {
  const puts: { key: string; n: number; at: number }[] = [];
  const deletes: string[] = [];
  const panels = new Set<string>();
  return {
    puts,
    deletes,
    panels,
    api: {
      putPanel: (channelId: string, key: string, v: PanelView) => {
        if (!panels.has(key) && options.limit !== undefined && panels.size >= options.limit) {
          return Promise.reject(new HarmonyError(409, 'panel_limit', 'full'));
        }
        panels.add(key);
        const block = v.blocks[0];
        puts.push({ key, n: block?.type === 'stat' ? Number(block.value) : -1, at: Date.now() });
        return Promise.resolve({} as never);
      },
      deletePanel: (_channelId: string, key: string) => {
        panels.delete(key);
        deletes.push(key);
        return Promise.resolve();
      },
    },
  };
}

describe('PanelSync', () => {
  it('writes a panel at most once per interval and the last state wins', async () => {
    const fake = fakeApi();
    const sync = new PanelSync(fake.api, { minIntervalMs: 100, gapMs: 0 });
    for (let i = 1; i <= 50; i += 1) {
      sync.set('c', 'cc-a', () => view(i));
      await sleep(2);
    }
    await sleep(350);
    sync.close();
    const times = fake.puts.map((p) => p.at);
    expect(fake.puts.length).toBeGreaterThanOrEqual(2);
    expect(fake.puts.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < times.length; i += 1) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(90);
    }
    expect(fake.puts.at(-1)?.n).toBe(50);
  });

  it('renders at write time, so a write never carries a state older than the latest change', async () => {
    const fake = fakeApi();
    const sync = new PanelSync(fake.api, { minIntervalMs: 50, gapMs: 0 });
    let current = 1;
    sync.set('c', 'cc-a', () => view(current));
    current = 2;
    sync.set('c', 'cc-a', () => view(current));
    await sleep(120);
    sync.close();
    expect(fake.puts.every((p) => p.n === 2)).toBe(true);
  });

  it('spaces writes of different panels so many agents stay under the bot limit', async () => {
    const fake = fakeApi();
    const sync = new PanelSync(fake.api, { minIntervalMs: 0, gapMs: 40 });
    for (let i = 0; i < 6; i += 1) sync.set('c', `ag-${String(i)}`, () => view(i));
    await sleep(350);
    sync.close();
    expect(fake.puts).toHaveLength(6);
    const span = (fake.puts.at(-1)?.at ?? 0) - (fake.puts[0]?.at ?? 0);
    expect(span).toBeGreaterThanOrEqual(5 * 35);
  });

  it('makes room when the channel is full and retries', async () => {
    const fake = fakeApi({ limit: 2 });
    const evicted: string[] = [];
    const sync = new PanelSync(fake.api, {
      minIntervalMs: 0,
      gapMs: 0,
      pickVictim: () => 'old-1',
      onEvicted: (key) => evicted.push(key),
    });
    fake.panels.add('old-1');
    fake.panels.add('old-2');
    sync.set('c', 'cc-new', () => view(1));
    await sleep(60);
    sync.close();
    expect(evicted).toEqual(['old-1']);
    expect(fake.panels.has('cc-new')).toBe(true);
    expect(fake.panels.has('old-1')).toBe(false);
  });

  it('remove deletes the panel and stops later writes of it', async () => {
    const fake = fakeApi();
    const sync = new PanelSync(fake.api, { minIntervalMs: 30, gapMs: 0 });
    sync.set('c', 'ag-1', () => view(1));
    await sleep(10);
    sync.set('c', 'ag-1', () => view(2));
    await sync.remove('ag-1');
    await sleep(80);
    sync.close();
    expect(fake.deletes).toEqual(['ag-1']);
    expect(fake.panels.has('ag-1')).toBe(false);
  });

  it('flush writes pending changes without waiting for the interval', async () => {
    const fake = fakeApi();
    const sync = new PanelSync(fake.api, { minIntervalMs: 5000, gapMs: 0 });
    sync.set('c', 'cc-a', () => view(1));
    await sleep(20);
    sync.set('c', 'cc-a', () => view(2));
    await sync.flush();
    sync.close();
    expect(fake.puts.at(-1)?.n).toBe(2);
  });
});
