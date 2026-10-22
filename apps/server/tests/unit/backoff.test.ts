import { describe, expect, it } from 'vitest';
import { backoffMs } from '../../src/events/backoff.js';

const BASE = 2000;
const CAP = 60 * 60 * 1000;

describe('delivery backoff', () => {
  it('doubles the jitter ceiling each attempt, from the base', () => {
    const top = () => 0.999999;
    const ceilings = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMs(n, BASE, CAP, top));
    expect(ceilings).toEqual([1999, 3999, 7999, 15999, 31999, 63999, 127999, 255999]);
  });

  it('caps the ceiling at one hour', () => {
    expect(backoffMs(30, BASE, CAP, () => 0.999999)).toBe(Math.floor(CAP * 0.999999));
    expect(backoffMs(12, BASE, CAP, () => 0.5)).toBe(CAP / 2);
  });

  it('uses full jitter: anywhere from zero up to the ceiling', () => {
    expect(backoffMs(3, BASE, CAP, () => 0)).toBe(0);
    expect(backoffMs(3, BASE, CAP, () => 0.5)).toBe(4000);
  });

  it('stays inside [0, ceiling) for random input', () => {
    for (let i = 0; i < 1000; i++) {
      const delay = backoffMs(4, BASE, CAP);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(BASE * 8);
    }
  });
});
