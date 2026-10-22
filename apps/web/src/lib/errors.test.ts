import { describe, expect, it } from 'vitest';
import { describeError, describeFailure } from './errors.js';

describe('describeError', () => {
  it('names the missing scope', () => {
    expect(describeError('missing_scope', 'This bot lacks the commands scope')).toContain(
      '"commands"',
    );
  });

  it('explains bot restrictions and blocked URLs', () => {
    expect(describeError('bot_not_allowed', 'Bots cannot use this endpoint')).toMatch(
      /Bots cannot/,
    );
    const text = describeError('url_not_allowed', 'Target address is not allowed (loopback)');
    expect(text).toContain('target address is not allowed (loopback)');
    expect(text).toContain('public');
  });

  it('falls back to the server message for unknown codes', () => {
    expect(describeError('weird', 'Something specific')).toBe('Something specific');
  });
});

describe('describeFailure', () => {
  it('has a sentence for every reason', () => {
    for (const reason of [
      'timeout',
      'unreachable',
      'bad_status',
      'invalid_response',
      'blocked_url',
      'post_failed',
    ] as const) {
      expect(describeFailure(reason).length).toBeGreaterThan(5);
    }
  });
});
