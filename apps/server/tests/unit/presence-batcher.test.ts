import { describe, expect, it } from 'vitest';
import type { PresenceEntry } from '@harmony/shared';
import { MAX_UPDATES_PER_FRAME, PresenceBatcher } from '../../src/presence/batcher.js';

/** A batcher on a fake clock: `tick` runs the timer if it is due. */
function setup(windowMs = 1000) {
  const flushed: { topic: string; updates: PresenceEntry[] }[] = [];
  let timer: { fn: () => void; at: number } | undefined;
  let now = 0;
  const batcher = new PresenceBatcher({
    windowMs,
    onFlush: (topic, updates) => flushed.push({ topic, updates }),
    setTimer: (fn, ms) => (timer = { fn, at: now + ms }),
    clearTimer: () => (timer = undefined),
  });
  return {
    batcher,
    flushed,
    tick(ms: number) {
      now += ms;
      if (timer && timer.at <= now) {
        const { fn } = timer;
        timer = undefined;
        fn();
      }
    },
    get timerSet() {
      return timer !== undefined;
    },
  };
}

describe('PresenceBatcher', () => {
  it('sends nothing before the window ends and one frame per topic at the end', () => {
    const t = setup();
    t.batcher.push('g1', 'a', 'online');
    t.batcher.push('g1', 'b', 'dnd');
    t.batcher.push('g2', 'c', 'idle');
    t.tick(999);
    expect(t.flushed).toEqual([]);
    t.tick(1);
    expect(t.flushed).toEqual([
      {
        topic: 'g1',
        updates: [
          { userId: 'a', status: 'online' },
          { userId: 'b', status: 'dnd' },
        ],
      },
      { topic: 'g2', updates: [{ userId: 'c', status: 'idle' }] },
    ]);
  });

  it('keeps the last write per user and orders updates by their last write', () => {
    const t = setup();
    t.batcher.push('g', 'a', 'online');
    t.batcher.push('g', 'b', 'online');
    t.batcher.push('g', 'a', 'idle');
    t.tick(1000);
    expect(t.flushed[0]?.updates).toEqual([
      { userId: 'b', status: 'online' },
      { userId: 'a', status: 'idle' },
    ]);
  });

  it('collapses a flap to nothing when the final state is what was last sent', () => {
    const t = setup();
    t.batcher.push('g', 'a', 'online');
    t.tick(1000);
    expect(t.flushed).toHaveLength(1);

    t.batcher.push('g', 'a', 'offline');
    t.batcher.push('g', 'a', 'online');
    t.tick(1000);
    expect(t.flushed).toHaveLength(1); // nothing new went out

    t.batcher.push('g', 'a', 'offline');
    t.batcher.push('g', 'a', 'online');
    t.batcher.push('g', 'a', 'offline');
    t.tick(1000);
    expect(t.flushed[1]?.updates).toEqual([{ userId: 'a', status: 'offline' }]);
  });

  it('collapses an offline flap too, but always sends a state it has never sent', () => {
    const t = setup();
    t.batcher.push('g', 'a', 'offline');
    t.tick(1000);
    expect(t.flushed[0]?.updates).toEqual([{ userId: 'a', status: 'offline' }]);
    t.batcher.push('g', 'a', 'online');
    t.batcher.push('g', 'a', 'offline');
    t.tick(1000);
    expect(t.flushed).toHaveLength(1);
  });

  it('sends the unchanged users of a window without the flapped one', () => {
    const t = setup();
    t.batcher.push('g', 'a', 'online');
    t.tick(1000);
    t.batcher.push('g', 'a', 'offline');
    t.batcher.push('g', 'b', 'online');
    t.batcher.push('g', 'a', 'online');
    t.tick(1000);
    expect(t.flushed[1]?.updates).toEqual([{ userId: 'b', status: 'online' }]);
  });

  it('forget() makes the next flush resend, for a socket that just joined the topic', () => {
    const t = setup();
    t.batcher.push('g', 'a', 'online');
    t.tick(1000);
    t.batcher.forget('g');
    t.batcher.push('g', 'a', 'online');
    t.tick(1000);
    expect(t.flushed).toHaveLength(2);
  });

  it('drop() discards pending updates and what was sent', () => {
    const t = setup();
    t.batcher.push('g', 'a', 'online');
    t.batcher.drop('g');
    t.tick(1000);
    expect(t.flushed).toEqual([]);
    t.batcher.push('g', 'a', 'online');
    t.tick(1000);
    expect(t.flushed).toHaveLength(1);
  });

  it('starts one timer per window, not one per push, and none when idle', () => {
    const t = setup();
    expect(t.timerSet).toBe(false);
    t.batcher.push('g', 'a', 'online');
    expect(t.timerSet).toBe(true);
    t.tick(1000);
    expect(t.timerSet).toBe(false);
  });

  it('delivers at once when the window is 0', () => {
    const t = setup(0);
    t.batcher.push('g', 'a', 'online');
    expect(t.flushed).toHaveLength(1);
    expect(t.timerSet).toBe(false);
  });

  it('splits a very large burst into several frames', () => {
    const t = setup();
    for (let i = 0; i < MAX_UPDATES_PER_FRAME * 2 + 1; i++) t.batcher.push('g', `u${i}`, 'online');
    t.tick(1000);
    expect(t.flushed.map((f) => f.updates.length)).toEqual([
      MAX_UPDATES_PER_FRAME,
      MAX_UPDATES_PER_FRAME,
      1,
    ]);
  });
});
