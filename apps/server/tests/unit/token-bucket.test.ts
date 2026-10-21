import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../../src/realtime/token-bucket.js';

describe('TokenBucket', () => {
  it('allows a burst up to capacity and then refuses', () => {
    const bucket = new TokenBucket(3, 1, () => 0);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('refills over time without exceeding capacity', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 2, () => now);
    for (let i = 0; i < 3; i++) bucket.take();
    now = 500;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    now = 3_600_000;
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('sustains 30 frames per 10 seconds', () => {
    let now = 0;
    const bucket = new TokenBucket(30, 3, () => now);
    let allowed = 0;
    for (let ms = 0; ms < 10_000; ms += 10) {
      now = ms;
      if (bucket.take()) allowed++;
    }
    expect(allowed).toBeGreaterThanOrEqual(55);
    expect(allowed).toBeLessThanOrEqual(61);
  });
});
