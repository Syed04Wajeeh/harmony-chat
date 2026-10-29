import { describe, expect, it } from 'vitest';
import { DockerClient } from '../../src/docker.ts';
import { fetchMonitors } from '../../src/kuma.ts';
import { PterodactylClient } from '../../src/pterodactyl.ts';
import { fakeDocker, json, PROXY, PTERO, PTERO_KEY, recordingFetch } from './helpers.ts';

describe('DockerClient', () => {
  const lists = { control: ['a'], status: ['b'] };

  it('returns only allowlisted containers, in config order', async () => {
    const d = fakeDocker({
      z: { state: 'running' },
      b: { state: 'exited' },
      a: { state: 'running', status: 'Up 2 hours (healthy)' },
    });
    const list = await new DockerClient(PROXY, lists, d.fetchImpl).list();
    expect(list.map((c) => [c.name, c.control, c.health])).toEqual([
      ['a', true, 'healthy'],
      ['b', false, undefined],
    ]);
  });

  it('cannot act on anything outside `control`, and never calls the proxy when it refuses', async () => {
    const d = fakeDocker({
      a: { state: 'running' },
      b: { state: 'running' },
      z: { state: 'running' },
    });
    const client = new DockerClient(PROXY, lists, d.fetchImpl);
    for (const name of ['b', 'z', '', '../a', 'a/../z', 'A', 'a ']) {
      await expect(client.act('restart', name), name).rejects.toThrow(
        /not something this bot controls/,
      );
    }
    await expect(client.inspect('z')).rejects.toThrow(/not something/);
    // Verbs outside start, stop and restart do not exist for it either.
    await expect(client.act('kill' as never, 'a')).rejects.toThrow(/not something/);
    await expect(client.act('rm' as never, 'a')).rejects.toThrow(/not something/);
    expect(d.fetchImpl.calls).toEqual([]);
  });

  it('refuses a config with an odd container name', () => {
    expect(() => new DockerClient(PROXY, { control: ['a/../b'], status: [] })).toThrow(
      /not a valid container name/,
    );
  });

  it('maps failures to messages that carry no address and no body', async () => {
    const down = new DockerClient(
      PROXY,
      lists,
      recordingFetch(() => Promise.reject(new Error(`connect ECONNREFUSED ${PROXY}`))),
    );
    const error = await down.list().catch((e: Error) => e);
    expect((error as Error).message).toMatch(/proxy did not answer/);
    expect((error as Error).message).not.toContain('docker-proxy-secret-host');

    const status = (code: number, body?: unknown) =>
      new DockerClient(
        PROXY,
        lists,
        recordingFetch(() => json(code, body)),
      );
    await expect(status(403).act('restart', 'a')).rejects.toThrow(
      'The Docker proxy refused that request.',
    );
    await expect(status(404).act('restart', 'a')).rejects.toThrow('Container a does not exist.');
    await expect(
      status(500, { message: 'cannot restart: boom\u0000' }).act('restart', 'a'),
    ).rejects.toThrow('Docker said no (500): cannot restart: boom.');
    expect(await status(304).act('start', 'a')).toBe('unchanged');
  });

  it('uses exactly the documented request shapes', async () => {
    const d = fakeDocker({ a: { state: 'running' } });
    const client = new DockerClient(PROXY, lists, d.fetchImpl);
    await client.list();
    await client.inspect('a');
    await client.act('stop', 'a');
    await client.act('start', 'a');
    await client.act('restart', 'a');
    expect(d.fetchImpl.calls.map((c) => `${c.method} ${c.url.replace(PROXY, '')}`)).toEqual([
      'GET /containers/json?all=1',
      'GET /containers/a/json',
      'POST /containers/a/stop?t=10',
      'POST /containers/a/start',
      'POST /containers/a/restart?t=10',
    ]);
  });
});

describe('PterodactylClient', () => {
  const server = {
    attributes: { identifier: 'abcd1234', name: 'Core\u0000 Keeper', is_suspended: false },
  };

  it('lists servers across pages and sends the key only as a bearer header', async () => {
    const f = recordingFetch((call) => {
      const page = new URL(call.url).searchParams.get('page');
      return json(200, {
        data:
          page === '1'
            ? [server]
            : [
                { attributes: { identifier: 'zzzz9999', name: 'Two' } },
                { attributes: { identifier: '../bad', name: 'Bad' } },
              ],
        meta: { pagination: { total_pages: 2 } },
      });
    });
    const servers = await new PterodactylClient(PTERO, PTERO_KEY, f).listServers();
    expect(servers.map((s) => [s.id, s.name])).toEqual([
      ['abcd1234', 'Core Keeper'],
      ['zzzz9999', 'Two'],
    ]);
    for (const call of f.calls) {
      expect(call.headers['authorization']).toBe(`Bearer ${PTERO_KEY}`);
      expect(call.url).not.toContain(PTERO_KEY);
    }
  });

  it('reads resources', async () => {
    const f = recordingFetch(() =>
      json(200, {
        attributes: {
          current_state: 'running',
          resources: {
            cpu_absolute: 5.5,
            memory_bytes: 1073741824,
            memory_limit_bytes: 2147483648,
            uptime: 60000,
          },
        },
      }),
    );
    expect(await new PterodactylClient(PTERO, PTERO_KEY, f).resources('abcd1234')).toEqual({
      state: 'running',
      cpuPercent: 5.5,
      memoryBytes: 1073741824,
      memoryLimitMb: 2048,
      uptimeMs: 60000,
    });
  });

  it('sends only start, stop and restart, and only to well-formed ids', async () => {
    const f = recordingFetch(() => json(204));
    const client = new PterodactylClient(PTERO, PTERO_KEY, f);
    await client.power('abcd1234', 'restart');
    expect(f.calls[0]).toMatchObject({ method: 'POST', body: { signal: 'restart' } });
    expect(f.calls[0]?.url).toBe(`${PTERO}/api/client/servers/abcd1234/power`);
    await expect(client.power('abcd1234', 'kill' as never)).rejects.toThrow(/not allowed/);
    await expect(client.power('../x', 'start')).rejects.toThrow(/not a game server id/);
    await expect(client.resources('ABCD1234')).rejects.toThrow(/not a game server id/);
    expect(f.calls).toHaveLength(1);
  });

  it('maps errors without leaking the key or the panel address', async () => {
    const status = (code: number) =>
      new PterodactylClient(
        PTERO,
        PTERO_KEY,
        recordingFetch(() => json(code, { errors: [{ detail: PTERO_KEY }] })),
      );
    await expect(status(401).resources('abcd1234')).rejects.toThrow(
      'The game panel rejected the bot’s API key.',
    );
    await expect(status(409).power('abcd1234', 'start')).rejects.toThrow(/busy/);
    await expect(status(429).power('abcd1234', 'start')).rejects.toThrow(/rate limiting/);
    await expect(status(500).power('abcd1234', 'start')).rejects.toThrow(
      'The game panel said no (500).',
    );
    const down = new PterodactylClient(
      PTERO,
      PTERO_KEY,
      recordingFetch(() => Promise.reject(new Error(`${PTERO} ${PTERO_KEY}`))),
    );
    const error = await down.listServers().catch((e: Error) => e);
    expect((error as Error).message).toBe('The game panel did not answer.');
  });
});

describe('Uptime Kuma', () => {
  it('combines the status page and heartbeats', async () => {
    const f = recordingFetch((call) =>
      call.url.endsWith('/heartbeat/home')
        ? json(200, {
            heartbeatList: { '1': [{ status: 1 }], '2': [{ status: 1 }, { status: 0 }] },
            uptimeList: { '1_24': 1, '2_24': 0.9567 },
          })
        : json(200, {
            publicGroupList: [
              {
                name: 'Core',
                monitorList: [
                  { id: 1, name: 'Web' },
                  { id: 2, name: 'Mail' },
                  { id: 3, name: 'New' },
                ],
              },
            ],
          }),
    );
    const monitors = await fetchMonitors({ baseUrl: 'http://kuma:3001', slug: 'home' }, f);
    expect(monitors).toEqual([
      { name: 'Web', group: 'Core', status: 1, uptime: 100 },
      { name: 'Mail', group: 'Core', status: 0, uptime: 95.7 },
      { name: 'New', group: 'Core', status: undefined, uptime: undefined },
    ]);
    expect(f.calls.map((c) => c.url)).toEqual([
      'http://kuma:3001/api/status-page/home',
      'http://kuma:3001/api/status-page/heartbeat/home',
    ]);
  });

  it('says so when Kuma cannot be read', async () => {
    await expect(
      fetchMonitors(
        { baseUrl: 'http://kuma:3001', slug: 'home' },
        recordingFetch(() => json(404)),
      ),
    ).rejects.toThrow(/said no \(404\)/);
    await expect(
      fetchMonitors(
        { baseUrl: 'http://kuma:3001', slug: 'home' },
        recordingFetch(() => Promise.reject(new Error('x'))),
      ),
    ).rejects.toThrow(/did not answer/);
  });
});
