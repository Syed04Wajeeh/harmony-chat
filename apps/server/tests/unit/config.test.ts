import { describe, expect, it } from 'vitest';
import { loadConfig, loadDatabaseUrl } from '../../src/config.js';

const required = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost',
  PROXY_SHARED_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(required);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 8080,
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      PUBLIC_ORIGIN: 'http://localhost:5173',
      ALLOWED_LOGINS: [],
      MESSAGE_RATE_MAX: 20,
      UPLOAD_DIR: '/data/uploads',
      MODULES_DISABLED: [],
      PRESENCE_TTL_MS: 90_000,
      PRESENCE_HEARTBEAT_MS: 30_000,
      WS_FRAME_BURST: 30,
    });
    expect(config.INSTANCE_ID).not.toBe('');
  });

  it('coerces PORT from a string', () => {
    expect(loadConfig({ ...required, PORT: '9000' }).PORT).toBe(9000);
  });

  it('fails fast and names the missing variables', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ ...required, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => loadConfig({ ...required, PORT: '70000' })).toThrow(/PORT/);
  });

  it('treats empty variables as unset', () => {
    const config = loadConfig({ ...required, ALLOWED_LOGINS: '', DEV_AUTH_LOGIN: '', PORT: '' });
    expect(config.ALLOWED_LOGINS).toEqual([]);
    expect(config.PORT).toBe(8080);
  });

  describe('proxy secret', () => {
    const base = { DATABASE_URL: required.DATABASE_URL, REDIS_URL: required.REDIS_URL };

    it('is required', () => {
      expect(() => loadConfig(base)).toThrow(/PROXY_SHARED_SECRET/);
    });

    it('must be at least 32 characters', () => {
      expect(() => loadConfig({ ...base, PROXY_SHARED_SECRET: 'short' })).toThrow(
        /PROXY_SHARED_SECRET/,
      );
    });

    it('is optional in development with DEV_AUTH_LOGIN', () => {
      const config = loadConfig({
        ...base,
        NODE_ENV: 'development',
        DEV_AUTH_LOGIN: 'Dev@Example.com',
      });
      expect(config.DEV_AUTH_LOGIN).toBe('dev@example.com');
    });
  });

  describe('dev auth', () => {
    it.each(['production', 'test'])('is rejected when NODE_ENV=%s', (NODE_ENV) => {
      expect(() =>
        loadConfig({
          ...required,
          NODE_ENV,
          DEV_AUTH_LOGIN: 'dev@example.com',
          PUBLIC_ORIGIN: 'https://chat.example.ts.net:18470',
        }),
      ).toThrow(/DEV_AUTH_LOGIN/);
    });
  });

  describe('PUBLIC_ORIGIN', () => {
    it('is required in production', () => {
      expect(() => loadConfig({ ...required, NODE_ENV: 'production' })).toThrow(/PUBLIC_ORIGIN/);
    });

    it('must be a URL and is normalized to an origin', () => {
      expect(() => loadConfig({ ...required, PUBLIC_ORIGIN: 'nope' })).toThrow(/PUBLIC_ORIGIN/);
      expect(
        loadConfig({ ...required, PUBLIC_ORIGIN: 'https://Chat.Example.ts.net:18470/path/' })
          .PUBLIC_ORIGIN,
      ).toBe('https://chat.example.ts.net:18470');
    });
  });

  it('parses ALLOWED_LOGINS as a lowercase list', () => {
    const config = loadConfig({ ...required, ALLOWED_LOGINS: ' A@x.com, b@y.com ,' });
    expect(config.ALLOWED_LOGINS).toEqual(['a@x.com', 'b@y.com']);
  });
});

describe('loadDatabaseUrl', () => {
  it('needs only DATABASE_URL', () => {
    expect(loadDatabaseUrl({ DATABASE_URL: 'postgres://x' })).toBe('postgres://x');
    expect(() => loadDatabaseUrl({})).toThrow(/DATABASE_URL/);
  });
});
