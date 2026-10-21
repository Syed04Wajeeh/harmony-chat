import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROXY_SECRET,
  PUBLIC_ORIGIN,
  TestSocket,
  api,
  createInfra,
  proxyHeaders,
  type Infra,
  type TestApp,
} from './support/harness.js';

describe('authentication', () => {
  let infra: Infra;
  let target: TestApp;

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp();
  });

  afterAll(() => infra.stop());

  const get = (path: string, headers: Record<string, string>) =>
    fetch(`${target.url}${path}`, { headers });

  it('rejects requests without the proxy secret', async () => {
    const res = await get('/api/me', { 'tailscale-user-login': 'a@example.com' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'proxy_required' });
  });

  it('rejects a wrong proxy secret', async () => {
    const res = await get('/api/me', {
      'x-harmony-proxy-secret': 'wrong'.repeat(10),
      'tailscale-user-login': 'a@example.com',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'proxy_required' });
  });

  it('rejects Funnel traffic', async () => {
    const res = await get(
      '/api/me',
      proxyHeaders('a@example.com', { 'tailscale-funnel-request': '?1' }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'funnel_not_allowed' });
  });

  it('rejects requests with no identity (tagged nodes)', async () => {
    const res = await get('/api/me', { 'x-harmony-proxy-secret': PROXY_SECRET });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'no_identity' });
  });

  it('protects every API route, not just /api/me', async () => {
    for (const path of ['/api/channels', '/api/channels/1/messages']) {
      expect((await get(path, {})).status).toBe(403);
    }
  });

  it('returns the authenticated user and decodes the display name', async () => {
    const res = await get(
      '/api/me',
      proxyHeaders('Grace@Example.com', {
        'tailscale-user-name': '=?utf-8?q?Gr=C3=A2ce_Hopper?=',
        'tailscale-user-profile-pic': 'https://example.com/g.png',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      login: 'grace@example.com',
      displayName: 'Grâce Hopper',
      avatarUrl: 'https://example.com/g.png',
    });
  });

  it('upserts the user and updates changed profile fields', async () => {
    const login = 'upsert@example.com';
    const first = await api(target, login)('/api/me');
    const second = await get('/api/me', proxyHeaders(login, { 'tailscale-user-name': 'Renamed' }));
    // The cache serves the old profile only while the values match; a change is written through.
    const body = (await second.json()) as { id: string; displayName: string };
    expect(body.displayName).toBe('Renamed');
    expect(body.id).toBe((first.body as { id: string }).id);

    const rows = await infra.db
      .selectFrom('users')
      .selectAll()
      .where('login', '=', login)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.display_name).toBe('Renamed');
  });

  describe('Origin checks', () => {
    const body = JSON.stringify({ content: 'hi' });
    const post = (headers: Record<string, string>) =>
      fetch(`${target.url}/api/channels/1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
    const withoutOrigin = (): Record<string, string> =>
      Object.fromEntries(
        Object.entries(proxyHeaders('origin@example.com')).filter(([name]) => name !== 'origin'),
      );

    it('rejects POST without an Origin', async () => {
      const res = await post(withoutOrigin());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'bad_origin' });
    });

    it('rejects POST from another origin', async () => {
      const res = await post(
        proxyHeaders('origin@example.com', { origin: 'https://evil.example.com' }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'bad_origin' });
    });

    it('accepts POST from the public origin', async () => {
      const res = await post(proxyHeaders('origin@example.com'));
      expect(res.status).toBe(201);
    });

    it('rejects a WebSocket upgrade without an Origin', async () => {
      await expect(
        TestSocket.connect(target, 'origin@example.com', { origin: '' }),
      ).rejects.toThrow('HTTP 403');
    });

    it('rejects a WebSocket upgrade from another origin', async () => {
      await expect(
        TestSocket.connect(target, 'origin@example.com', { origin: 'https://evil.example.com' }),
      ).rejects.toThrow('HTTP 403');
    });

    it('accepts a WebSocket upgrade from the public origin', async () => {
      const socket = await TestSocket.connect(target, 'origin@example.com', {
        origin: PUBLIC_ORIGIN,
      });
      const [hello] = await socket.waitFor('hello');
      expect(hello?.user.login).toBe('origin@example.com');
      await socket.close();
    });

    it('rejects a WebSocket upgrade without identity', async () => {
      await expect(
        TestSocket.connect(target, 'x@example.com', { 'tailscale-user-login': '' }),
      ).rejects.toThrow('HTTP 401');
    });
  });

  describe('allowlist', () => {
    it('admits only listed logins, case-insensitively', async () => {
      const restricted = await infra.startApp({
        ALLOWED_LOGINS: 'Allowed@Example.com, other@example.com',
      });
      const call = async (login: string) =>
        (
          await fetch(`${restricted.url}/api/me`, {
            headers: proxyHeaders(login),
          })
        ).status;
      expect(await call('allowed@example.com')).toBe(200);
      expect(await call('ALLOWED@example.com')).toBe(200);
      expect(await call('stranger@example.com')).toBe(403);
    });
  });
});
