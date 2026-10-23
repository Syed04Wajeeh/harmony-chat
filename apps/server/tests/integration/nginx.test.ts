import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const NGINX_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../deploy/nginx',
);
const nginxFile = (name: string) => readFileSync(path.join(NGINX_DIR, name), 'utf8');
const SECRET = 'nginx-test-secret-nginx-test-secret-0123456789';

// A stand-in upstream that echoes what nginx forwarded, so the real template can be exercised
// without the app (the host firewall may not allow containers to reach it).
const ECHO_UPSTREAM = `
server {
  listen 8080;
  client_max_body_size 20m;
  location / {
    default_type text/plain;
    return 200 "secret=$http_x_harmony_proxy_secret;upgrade=$http_upgrade;login=$http_tailscale_user_login;path=$uri;method=$request_method;auth=$http_authorization;name=$http_tailscale_user_name;funnel=$http_tailscale_funnel_request";
  }
}
`;

describe('nginx reverse proxy template', () => {
  let network: StartedNetwork;
  let upstream: StartedTestContainer;
  let nginx: StartedTestContainer;
  let host: string;
  let port: number;
  let ingressPort: number;
  const identity = { 'tailscale-user-login': 'proxied@example.com' };

  beforeAll(async () => {
    network = await new Network().start();
    upstream = await new GenericContainer('nginx:1.27-alpine')
      .withNetwork(network)
      .withNetworkAliases('app1', 'app2')
      .withCopyContentToContainer([
        { content: ECHO_UPSTREAM, target: '/etc/nginx/conf.d/default.conf' },
      ])
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    nginx = await new GenericContainer('nginx:1.27-alpine')
      .withNetwork(network)
      .withEnvironment({ PROXY_SHARED_SECRET: SECRET, NGINX_ENVSUBST_FILTER: 'PROXY_' })
      .withCopyContentToContainer([
        // Production runs these in two containers; one container exercises both listeners.
        { content: nginxFile('common.conf'), target: '/etc/nginx/conf.d/00-common.conf' },
        {
          content: nginxFile('user.conf.template'),
          target: '/etc/nginx/templates/default.conf.template',
        },
        { content: nginxFile('integrations.conf'), target: '/etc/nginx/conf.d/integrations.conf' },
      ])
      .withExposedPorts(8080, 8081)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    host = nginx.getHost();
    port = nginx.getMappedPort(8080);
    ingressPort = nginx.getMappedPort(8081);
  }, 120_000);

  afterAll(async () => {
    await nginx.stop();
    await upstream.stop();
    await network.stop();
  });

  const url = (p: string) => `http://${host}:${port}${p}`;
  const ingress = (p: string) => `http://${host}:${ingressPort}${p}`;

  it('stamps the proxy secret on plain requests, overwriting a client-supplied one', async () => {
    const res = await fetch(url('/api/me'), {
      headers: { ...identity, 'x-harmony-proxy-secret': 'forged-by-the-client' },
    });
    const body = await res.text();
    expect(body).toContain(`secret=${SECRET};`);
    expect(body).toContain('login=proxied@example.com');
  });

  it('stamps the secret on the WebSocket location and forwards the upgrade', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        url('/api/ws'),
        { headers: { ...identity, connection: 'Upgrade', upgrade: 'websocket' } },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => resolve(data));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(body).toContain(`secret=${SECRET};`);
    expect(body).toContain('upgrade=websocket');
    expect(body).toContain('path=/api/ws');
  });

  it('stamps the secret on the upload location, overwriting a forged one', async () => {
    const res = await fetch(url('/api/uploads'), {
      method: 'POST',
      headers: { ...identity, 'x-harmony-proxy-secret': 'forged' },
      body: new Uint8Array(1024),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`secret=${SECRET};`);
  });

  it('accepts bodies up to 51m only on /api/uploads and keeps 1m elsewhere', async () => {
    const body = new Uint8Array(2_000_000);
    const upload = await fetch(url('/api/uploads'), { method: 'POST', headers: identity, body });
    expect(upload.status).toBe(200);
    expect(await upload.text()).toContain(`secret=${SECRET};`);

    const other = await fetch(url('/api/channels/1/messages'), {
      method: 'POST',
      headers: identity,
      body,
    });
    expect(other.status).toBe(413);

    const huge = await fetch(url('/api/uploads'), {
      method: 'POST',
      headers: identity,
      body: new Uint8Array(52_000_000),
    });
    expect(huge.status).toBe(413);
  }, 60_000);

  it('does not extend the larger limit to look-alike paths', async () => {
    const res = await fetch(url('/api/uploads/extra'), {
      method: 'POST',
      headers: identity,
      body: new Uint8Array(2_000_000),
    });
    expect(res.status).toBe(413);
  });
  describe('integration ingress (host-local, port 8081)', () => {
    const humanHeaders = {
      'tailscale-user-login': 'admin@example.com',
      'tailscale-user-name': 'Admin',
      'tailscale-funnel-request': '?1',
      'x-harmony-proxy-secret': 'forged-by-the-client',
    };

    it('proxies incoming webhooks without the proxy secret or any identity', async () => {
      const res = await fetch(ingress('/api/webhooks/12/sometoken?wait=true'), {
        method: 'POST',
        headers: humanHeaders,
        body: '{}',
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('path=/api/webhooks/12/sometoken');
      expect(body).toContain('secret=;');
      expect(body).toContain('login=;');
      expect(body).toContain('name=;');
      expect(body).toContain('funnel=');
      expect(body).not.toContain('funnel=?1');
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain('forged-by-the-client');
      expect(body).not.toContain('admin@example.com');
    });

    it('proxies interaction follow-ups', async () => {
      const res = await fetch(ingress('/api/interactions/3/token/followup'), {
        method: 'POST',
        headers: humanHeaders,
        body: '{}',
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('secret=;');
      expect(body).toContain('login=;');
    });

    it('proxies requests with Authorization: Bot, stripping identity and the secret', async () => {
      for (const scheme of ['Bot', 'bot', 'BOT']) {
        const res = await fetch(ingress('/api/channels/1/messages'), {
          method: 'POST',
          headers: { ...humanHeaders, authorization: `${scheme} hb_1_abc` },
          body: '{}',
        });
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('auth=' + scheme + ' hb_1_abc');
        expect(body).toContain('secret=;');
        expect(body).toContain('login=;');
        expect(body).not.toContain(SECRET);
      }
    });

    it('forwards bot WebSocket upgrades only with a bot token', async () => {
      const upgrade = (headers: Record<string, string>) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = request(
            ingress('/api/ws'),
            { headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } },
            (res) => {
              let data = '';
              res.on('data', (chunk: Buffer) => (data += chunk.toString()));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
            },
          );
          req.on('error', reject);
          req.end();
        });
      const bot = await upgrade({ authorization: 'Bot hb_1_abc', ...humanHeaders });
      expect(bot.status).toBe(200);
      expect(bot.body).toContain('upgrade=websocket');
      expect(bot.body).toContain('secret=;');
      expect((await upgrade(humanHeaders)).status).toBe(404);
    });

    it('returns 404 for everything else, whoever is asking', async () => {
      const probes: [string, string, Record<string, string>][] = [
        ['GET', '/api/me', humanHeaders],
        ['GET', '/api/channels', humanHeaders],
        ['POST', '/api/channels/1/messages', humanHeaders],
        ['POST', '/api/channels/1/messages', { ...humanHeaders, authorization: 'Bearer hb_1_abc' }],
        [
          'POST',
          '/api/channels/1/messages',
          { ...humanHeaders, authorization: 'Basic dXNlcjpwYXNz' },
        ],
        ['POST', '/api/channels/1/messages', { ...humanHeaders, authorization: 'Botany x' }],
        ['POST', '/api/channels/1/messages', { ...humanHeaders, authorization: 'Bot' }],
        ['DELETE', '/api/webhooks/12', humanHeaders],
        ['GET', '/api/webhooks/12/sometoken', humanHeaders],
        ['GET', '/api/interactions/3/token/followup', humanHeaders],
        ['POST', '/api/webhooksX/12/sometoken', humanHeaders],
        ['POST', '/api/webhooks/../me', humanHeaders],
        ['POST', '/api/uploads', humanHeaders],
        ['GET', '/api/ws', humanHeaders],
        ['GET', '/healthz', {}],
        ['GET', '/readyz', {}],
        ['GET', '/', {}],
        ['GET', '/assets/index.js', {}],
      ];
      for (const [method, path, headers] of probes) {
        const res = await fetch(ingress(path), {
          method,
          headers,
          redirect: 'manual',
          ...(method === 'POST' && { body: '{}' }),
        });
        expect(res.status, `${method} ${path} ${headers.authorization ?? ''}`).toBe(404);
        expect(await res.text()).not.toContain('secret=');
      }
    });

    it('keeps the 1m body limit', async () => {
      const res = await fetch(ingress('/api/webhooks/12/sometoken'), {
        method: 'POST',
        body: new Uint8Array(2_000_000),
      });
      expect(res.status).toBe(413);
    });

    it('leaves the main listener untouched: it still stamps the secret', async () => {
      const res = await fetch(url('/api/webhooks/12/sometoken'), { method: 'POST', body: '{}' });
      expect(await res.text()).toContain(`secret=${SECRET};`);
    });
  });
});
