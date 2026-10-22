import { describe, expect, it } from 'vitest';
import { backoffDelay, parseFrame } from './realtime.js';

describe('backoffDelay', () => {
  it('grows exponentially with jitter and is capped', () => {
    expect(backoffDelay(0, () => 0)).toBe(250);
    expect(backoffDelay(0, () => 1)).toBe(500);
    expect(backoffDelay(3, () => 1)).toBe(4000);
    expect(backoffDelay(20, () => 1)).toBe(30_000);
    expect(backoffDelay(20, () => 0)).toBe(15_000);
  });
});

describe('parseFrame', () => {
  it('keeps core frames and module frames apart and drops the rest', () => {
    expect(parseFrame('{"type":"typing","channelId":"1","userId":"2"}')?.core).toBeDefined();
    expect(parseFrame('{"type":"polls.updated","x":1}')?.module).toMatchObject({ x: 1 });
    expect(parseFrame('{"type":"explode"}')).toBeNull();
    expect(parseFrame('nope')).toBeNull();
  });
});
