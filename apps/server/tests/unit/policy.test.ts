import { describe, expect, it } from 'vitest';
import {
  authenticate,
  hasValidProxySecret,
  isAllowedOrigin,
  isAuthFailure,
  parseIdentity,
  requiresOriginCheck,
  type AuthPolicy,
} from '../../src/auth/policy.js';

const SECRET = 's'.repeat(32);
const ORIGIN = 'https://chat.example.ts.net:18470';
const policy: AuthPolicy = { proxySecret: SECRET, publicOrigin: ORIGIN, allowedLogins: [] };

const good = {
  'x-harmony-proxy-secret': SECRET,
  'tailscale-user-login': 'Ada@Example.com',
  'tailscale-user-name': '=?utf-8?q?Ada_L=C3=B6velace?=',
};

describe('hasValidProxySecret', () => {
  it('accepts the exact secret', () => {
    expect(hasValidProxySecret({ 'x-harmony-proxy-secret': SECRET }, SECRET)).toBe(true);
  });

  it.each([
    ['missing', {}],
    ['wrong', { 'x-harmony-proxy-secret': 'x'.repeat(32) }],
    ['shorter', { 'x-harmony-proxy-secret': 'short' }],
    ['longer', { 'x-harmony-proxy-secret': SECRET + 'extra' }],
    ['empty', { 'x-harmony-proxy-secret': '' }],
  ])('rejects a %s secret', (_name, headers) => {
    expect(hasValidProxySecret(headers, SECRET)).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    expect(hasValidProxySecret({ 'x-harmony-proxy-secret': '' }, undefined)).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('matches the public origin exactly', () => {
    expect(isAllowedOrigin(ORIGIN, ORIGIN)).toBe(true);
    expect(isAllowedOrigin('HTTPS://CHAT.EXAMPLE.TS.NET:18470', ORIGIN)).toBe(true);
  });

  it.each([
    undefined,
    '',
    'null',
    'https://evil.example.com',
    'http://chat.example.ts.net:18470',
    'https://chat.example.ts.net',
    'https://chat.example.ts.net:18471',
    'https://chat.example.ts.net:18470.evil.com',
  ])('rejects %s', (origin) => {
    expect(isAllowedOrigin(origin, ORIGIN)).toBe(false);
  });
});

describe('requiresOriginCheck', () => {
  it('exempts safe methods but not state-changing ones', () => {
    expect(requiresOriginCheck({ method: 'GET', headers: {} })).toBe(false);
    expect(requiresOriginCheck({ method: 'OPTIONS', headers: {} })).toBe(false);
    expect(requiresOriginCheck({ method: 'POST', headers: {} })).toBe(true);
    expect(requiresOriginCheck({ method: 'DELETE', headers: {} })).toBe(true);
  });

  it('covers WebSocket upgrades', () => {
    expect(requiresOriginCheck({ method: 'GET', headers: { upgrade: 'WebSocket' } })).toBe(true);
  });
});

describe('parseIdentity', () => {
  it('lowercases the login and decodes the display name', () => {
    expect(parseIdentity(good)).toEqual({
      login: 'ada@example.com',
      displayName: 'Ada Lövelace',
      avatarUrl: null,
    });
  });

  it('falls back to the login local part when the name is empty', () => {
    expect(parseIdentity({ 'tailscale-user-login': 'ada@example.com' })?.displayName).toBe('ada');
    expect(
      parseIdentity({ 'tailscale-user-login': 'ada@example.com', 'tailscale-user-name': '' })
        ?.displayName,
    ).toBe('ada');
  });

  it('returns null without a login', () => {
    expect(parseIdentity({})).toBeNull();
    expect(parseIdentity({ 'tailscale-user-login': '  ' })).toBeNull();
  });

  it('only keeps http(s) avatar URLs', () => {
    const login = 'ada@example.com';
    expect(
      parseIdentity({
        'tailscale-user-login': login,
        'tailscale-user-profile-pic': 'https://x/y.png',
      })?.avatarUrl,
    ).toBe('https://x/y.png');
    expect(
      parseIdentity({ 'tailscale-user-login': login, 'tailscale-user-profile-pic': 'javascript:1' })
        ?.avatarUrl,
    ).toBeNull();
  });
});

describe('authenticate', () => {
  const get = (headers: Record<string, string>) => ({ method: 'GET', headers });

  it('returns the identity for a valid proxied request', () => {
    expect(authenticate(get(good), policy)).toMatchObject({ login: 'ada@example.com' });
  });

  it('checks the proxy secret first', () => {
    const result = authenticate(get({ 'tailscale-user-login': 'a@b.c' }), policy);
    expect(result).toMatchObject({ statusCode: 403, code: 'proxy_required' });
  });

  it('rejects Funnel traffic', () => {
    const result = authenticate(get({ ...good, 'tailscale-funnel-request': '?1' }), policy);
    expect(result).toMatchObject({ statusCode: 403, code: 'funnel_not_allowed' });
  });

  it('rejects requests without an identity', () => {
    const result = authenticate(get({ 'x-harmony-proxy-secret': SECRET }), policy);
    expect(result).toMatchObject({ statusCode: 401, code: 'no_identity' });
  });

  it('enforces the allowlist case-insensitively', () => {
    const allow = { ...policy, allowedLogins: ['ada@example.com'] };
    expect(isAuthFailure(authenticate(get(good), allow))).toBe(false);
    const other = { ...good, 'tailscale-user-login': 'eve@example.com' };
    expect(authenticate(get(other), allow)).toMatchObject({ statusCode: 403, code: 'not_allowed' });
  });

  it('requires a matching Origin on POST', () => {
    const post = (headers: Record<string, string>) => ({ method: 'POST', headers });
    expect(authenticate(post(good), policy)).toMatchObject({ code: 'bad_origin' });
    expect(
      authenticate(post({ ...good, origin: 'https://evil.example.com' }), policy),
    ).toMatchObject({
      code: 'bad_origin',
    });
    expect(isAuthFailure(authenticate(post({ ...good, origin: ORIGIN }), policy))).toBe(false);
  });

  it('requires a matching Origin on WebSocket upgrades', () => {
    const upgrade = { ...good, upgrade: 'websocket' };
    expect(authenticate(get(upgrade), policy)).toMatchObject({ code: 'bad_origin' });
    expect(isAuthFailure(authenticate(get({ ...upgrade, origin: ORIGIN }), policy))).toBe(false);
  });

  it('substitutes the dev identity and skips the proxy secret', () => {
    const dev: AuthPolicy = {
      publicOrigin: ORIGIN,
      allowedLogins: [],
      devIdentity: { login: 'dev@example.com', displayName: 'Dev', avatarUrl: null },
    };
    expect(authenticate(get({}), dev)).toMatchObject({ login: 'dev@example.com' });
  });
});
