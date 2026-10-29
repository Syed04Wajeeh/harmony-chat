import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { defuseMassMentions } from '../src/format.js';
import { RateLimiter } from '../src/rate-limit.js';

const TOKEN = `hb_5_${'s'.repeat(43)}`;

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ HARMONY_BOT_TOKEN: TOKEN })).toEqual({
      url: 'http://127.0.0.1:8471',
      token: TOKEN,
      defaultChannel: undefined,
      maxSendsPerMinute: 20,
      allowMassMentions: false,
    });
  });

  it('reads every option and trims a trailing slash', () => {
    const config = loadConfig({
      HARMONY_BOT_TOKEN: TOKEN,
      HARMONY_URL: 'https://chat.example.com/',
      HARMONY_DEFAULT_CHANNEL: '#ops',
      HARMONY_MAX_SENDS_PER_MINUTE: '5',
      HARMONY_ALLOW_MASS_MENTIONS: '1',
    });
    expect(config).toMatchObject({
      url: 'https://chat.example.com',
      defaultChannel: '#ops',
      maxSendsPerMinute: 5,
      allowMassMentions: true,
    });
  });

  it('rejects bad input without echoing the token', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ HARMONY_BOT_TOKEN: 'secret-value' })).toThrow(/does not look like/);
    try {
      loadConfig({ HARMONY_BOT_TOKEN: 'secret-value' });
    } catch (error) {
      expect(String(error)).not.toContain('secret-value');
    }
    expect(() => loadConfig({ HARMONY_BOT_TOKEN: TOKEN, HARMONY_URL: 'ftp://x' })).toThrow(/http/);
    expect(() =>
      loadConfig({ HARMONY_BOT_TOKEN: TOKEN, HARMONY_MAX_SENDS_PER_MINUTE: '0' }),
    ).toThrow(/positive/);
  });
});

describe('RateLimiter', () => {
  it('allows max uses per window, reports the wait and recovers', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect(limiter.take()).toBe(0);
    now = 10_000;
    expect(limiter.take()).toBe(0);
    expect(limiter.take()).toBe(50);
    now = 60_000;
    expect(limiter.take()).toBe(0);
  });
});

describe('defuseMassMentions', () => {
  it('breaks @everyone and @here in any case but leaves user mentions', () => {
    const out = defuseMassMentions('@everyone @Here <@7>');
    expect(out).not.toMatch(/@everyone|@here/i);
    expect(out).toContain('<@7>');
  });
});
