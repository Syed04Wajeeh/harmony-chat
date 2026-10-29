import { describe, expect, it } from 'vitest';
import type { Panel } from '@harmony/shared';
import { PanelCoalescer } from '../../src/panels/coalescer.js';

const panel = (id: string, version: number): Panel => ({
  id,
  channelId: '1',
  botId: '2',
  key: 'host',
  view: { blocks: [{ type: 'markdown', text: String(version) }] },
  version,
  pinned: false,
  position: 0,
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
});

/** A coalescer on a fake clock with one timer per panel, like the real thing. */
function setup(windowMs = 1000) {
  const published: Panel[] = [];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 0;
  let now = 0;
  const coalescer = new PanelCoalescer({
    windowMs,
    publish: (p) => published.push(p),
    setTimer: (fn, ms) => {
      timers.set(++next, { fn, at: now + ms });
      return next;
    },
    clearTimer: (handle) => timers.delete(handle as number),
  });
  return {
    coalescer,
    published,
    versions: () => published.map((p) => p.version),
    tick(ms: number) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.fn();
        }
      }
    },
    get timers() {
      return timers.size;
    },
  };
}

describe('PanelCoalescer', () => {
  it('publishes the first change at once (leading edge)', () => {
    const t = setup();
    t.coalescer.push(panel('1', 1));
    expect(t.versions()).toEqual([1]);
  });

  it('holds changes inside the window and sends only the newest at its end (trailing edge)', () => {
    const t = setup();
    t.coalescer.push(panel('1', 1));
    t.coalescer.push(panel('1', 2));
    t.coalescer.push(panel('1', 3));
    t.coalescer.push(panel('1', 4));
    expect(t.versions()).toEqual([1]);
    t.tick(999);
    expect(t.versions()).toEqual([1]);
    t.tick(1);
    expect(t.versions()).toEqual([1, 4]);
  });

  it('allows one publish per window under a steady stream, then goes quiet', () => {
    const t = setup();
    for (let version = 1; version <= 30; version++) {
      t.coalescer.push(panel('1', version));
      t.tick(100);
    }
    // 3 seconds of changes: the leading publish plus one per full window.
    expect(t.published.length).toBeLessThanOrEqual(4);
    expect(t.published.at(-1)?.version).toBeGreaterThanOrEqual(27);
    t.tick(5000);
    expect(t.published.at(-1)?.version).toBe(30);
    t.tick(5000);
    expect(t.timers).toBe(0);
  });

  it('publishes the next change at once after a quiet window', () => {
    const t = setup();
    t.coalescer.push(panel('1', 1));
    t.tick(1000);
    t.coalescer.push(panel('1', 2));
    expect(t.versions()).toEqual([1, 2]);
  });

  it('keeps panels independent', () => {
    const t = setup();
    t.coalescer.push(panel('1', 1));
    t.coalescer.push(panel('2', 1));
    t.coalescer.push(panel('1', 2));
    t.coalescer.push(panel('2', 2));
    expect(t.published.map((p) => `${p.id}:${String(p.version)}`)).toEqual(['1:1', '2:1']);
    t.tick(1000);
    expect(t.published.map((p) => `${p.id}:${String(p.version)}`)).toEqual([
      '1:1',
      '2:1',
      '1:2',
      '2:2',
    ]);
  });

  it('never replaces a newer pending panel with an older one', () => {
    const t = setup();
    t.coalescer.push(panel('1', 1));
    t.coalescer.push(panel('1', 5));
    t.coalescer.push(panel('1', 3));
    t.tick(1000);
    expect(t.versions()).toEqual([1, 5]);
  });

  it('cancel drops the trailing publish', () => {
    const t = setup();
    t.coalescer.push(panel('1', 1));
    t.coalescer.push(panel('1', 2));
    t.coalescer.cancel('1');
    t.tick(5000);
    expect(t.versions()).toEqual([1]);
    expect(t.timers).toBe(0);
  });

  it('a window of 0 publishes every push', () => {
    const t = setup(0);
    t.coalescer.push(panel('1', 1));
    t.coalescer.push(panel('1', 2));
    expect(t.versions()).toEqual([1, 2]);
    expect(t.timers).toBe(0);
  });

  it('stop discards pending work', () => {
    const t = setup();
    t.coalescer.push(panel('1', 1));
    t.coalescer.push(panel('1', 2));
    t.coalescer.stop();
    t.tick(5000);
    expect(t.versions()).toEqual([1]);
  });
});
