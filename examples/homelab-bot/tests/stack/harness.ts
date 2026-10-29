import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startThrowaway, waitForProxy, type Throwaway } from '../integration/docker-helpers.ts';

/**
 * Everything a stack test needs: a Harmony dev server (already running, see the README of this
 * example), throwaway containers behind a real socket proxy, a mock Pterodactyl panel, a bot in
 * gateway mode, and a few people. `cleanup` removes all of it.
 */
export interface Stack {
  origin: string;
  admin: Person;
  member: Person;
  guildId: string;
  dashboardId: string;
  opsId: string;
  botId: string;
  throwaway: Throwaway;
  game: { id: string; name: string; powerCalls: { signal: string }[]; state: { current: string } };
  bot: ChildProcess;
  botOutput: () => string;
  cleanup: () => void;
}

export class Person {
  readonly login: string;
  readonly origin: string;
  constructor(origin: string, login: string) {
    this.origin = origin;
    this.login = login;
  }
  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.origin + path, {
      method,
      headers: {
        cookie: `dev_login=${this.login}`,
        origin: this.origin,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${String(res.status)} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  me() {
    return this.call<{ id: string; isAdmin: boolean }>('GET', '/api/me');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(
  what: string,
  check: () => Promise<T | undefined | false>,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

function mockPanel(): { server: Server; url: Promise<string>; game: Stack['game'] } {
  const game: Stack['game'] = {
    id: 'abcd1234',
    name: 'Mock Keeper',
    powerCalls: [],
    state: { current: 'running' },
  };
  const server = createServer((req, res) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer ptlc_mock_key_for_tests') return send(401);
    if (req.url?.startsWith('/api/client?')) {
      return send(200, {
        data: [{ attributes: { identifier: game.id, name: game.name, is_suspended: false } }],
        meta: { pagination: { total_pages: 1 } },
      });
    }
    if (req.url === `/api/client/servers/${game.id}/resources`) {
      const running = game.state.current === 'running';
      return send(200, {
        attributes: {
          current_state: game.state.current,
          resources: {
            cpu_absolute: running ? 18.2 : 0,
            memory_bytes: running ? 1_932_735_283 : 0,
            memory_limit_bytes: 4 * 1024 ** 3,
            uptime: running ? 7_200_000 : 0,
          },
        },
      });
    }
    if (req.url === `/api/client/servers/${game.id}/power` && req.method === 'POST') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const signal = (JSON.parse(raw) as { signal: string }).signal;
        game.powerCalls.push({ signal });
        game.state.current = signal === 'stop' ? 'offline' : 'running';
        send(204);
      });
      return;
    }
    send(404);
  });
  const url = new Promise<string>((resolveUrl) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveUrl(
        `http://127.0.0.1:${typeof address === 'object' && address ? String(address.port) : '0'}`,
      );
    }),
  );
  return { server, url, game };
}

export async function startStack(
  origin = process.env['HARMONY_DEV_API'] ?? 'http://127.0.0.1:18080',
): Promise<Stack> {
  const run = Date.now().toString(36);
  const admin = new Person(origin, 'dev@example.com');
  if (!(await admin.me()).isAdmin) throw new Error('run against an empty dev database');
  const member = new Person(origin, `alice-${run}@example.com`);

  const guild = await admin.call<{ id: string }>('POST', '/api/guilds', { name: `Lab ${run}` });
  const dashboard = await admin.call<{ id: string }>('POST', `/api/guilds/${guild.id}/channels`, {
    name: 'homelab',
    kind: 'dashboard',
  });
  const ops = await admin.call<{ id: string }>('POST', `/api/guilds/${guild.id}/channels`, {
    name: 'ops',
  });
  const invite = await admin.call<{ code: string }>('POST', `/api/guilds/${guild.id}/invites`, {});
  await member.call('POST', `/api/invites/${invite.code}/accept`);

  // No URLs: interactions go over the gateway. `events` is only there so `resume` works.
  const made = await admin.call<{ bot: { id: string }; token: string }>('POST', '/api/bots', {
    name: `Homelab ${run}`,
    scopes: ['messages.write', 'commands', 'panels.write', 'channels.read', 'events'],
  });
  await admin.call('POST', `/api/guilds/${guild.id}/bots`, { botId: made.bot.id });

  const throwaway = startThrowaway(run);
  await waitForProxy(throwaway.proxyUrl);
  const panel = mockPanel();
  const panelUrl = await panel.url;

  const dir = mkdtempSync(join(tmpdir(), 'hb-stack-'));
  const configFile = join(dir, 'config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      harmony: {
        guildId: guild.id,
        dashboardChannel: 'homelab',
        opsChannel: 'ops',
        rolePermission: 'manage_guild',
      },
      docker: {
        proxyUrl: throwaway.proxyUrl,
        control: [throwaway.control],
        status: [throwaway.statusOnly],
      },
      pterodactyl: { url: panelUrl },
      refreshSeconds: 2,
      cooldownSeconds: 2,
    }),
  );
  const root = resolve(import.meta.dirname, '../..');
  const bot = spawn(process.execPath, ['src/main.ts'], {
    cwd: root,
    env: {
      PATH: process.env['PATH'] ?? '',
      CONFIG_FILE: configFile,
      HARMONY_URL: origin,
      HARMONY_BOT_TOKEN: made.token,
      PTERODACTYL_CLIENT_API_KEY: 'ptlc_mock_key_for_tests',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  bot.stdout.on('data', (c: Buffer) => (output += c.toString()));
  bot.stderr.on('data', (c: Buffer) => (output += c.toString()));

  const cleanup = () => {
    bot.kill();
    panel.server.close();
    throwaway.cleanup();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await until(
      'the bot to publish its panels',
      async () => {
        const { panels } = await admin.call<{ panels: { key: string }[] }>(
          'GET',
          `/api/channels/${dashboard.id}/panels`,
        );
        return panels.some((p) => p.key === 'containers') && panels.some((p) => p.key === 'games');
      },
      30_000,
    ).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : 'failed'}\n${output}`);
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    origin,
    admin,
    member,
    guildId: guild.id,
    dashboardId: dashboard.id,
    opsId: ops.id,
    botId: made.bot.id,
    throwaway,
    game: panel.game,
    bot,
    botOutput: () => output,
    cleanup,
  };
}
