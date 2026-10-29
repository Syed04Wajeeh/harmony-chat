import type { InteractionPayload } from '@harmony/shared';
import { HomelabBot } from '../../src/bot.ts';
import { buildConfig, type Config } from '../../src/config.ts';
import { DockerClient } from '../../src/docker.ts';
import { HarmonyApi, InteractionContext } from '../../src/harmony.ts';
import { Cooldown } from '../../src/targets.ts';
import { PterodactylClient } from '../../src/pterodactyl.ts';

export const TOKEN = 'hb_77_tokenSECRETtokenSECRETtokenSECRET1234567';
export const PTERO_KEY = 'ptlc_SECRETKEYSECRETKEYSECRETKEY123456789';
export const PROXY = 'http://docker-proxy-secret-host:2375';
export const PTERO = 'http://panel-secret-host:80';

export const json = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A fetch that records every call and answers through `handler`. */
export function recordingFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

export interface FakeContainer {
  state: string;
  status?: string;
}

/** A tiny Docker: list, inspect, start, stop, restart. */
export function fakeDocker(containers: Record<string, FakeContainer>) {
  const fetchImpl = recordingFetch((call) => {
    const url = new URL(call.url);
    if (call.method === 'GET' && url.pathname === '/containers/json') {
      return json(
        200,
        Object.entries(containers).map(([name, c]) => ({
          Names: [`/${name}`],
          State: c.state,
          Status: c.status ?? (c.state === 'running' ? 'Up 3 hours' : 'Exited (0) 2 days ago'),
        })),
      );
    }
    const match = /^\/containers\/([^/]+)\/(json|start|stop|restart)$/.exec(url.pathname);
    const name = match?.[1];
    const c = name ? containers[name] : undefined;
    if (!match || !c) return json(404, { message: 'no such container' });
    if (match[2] === 'json') return json(200, { State: { Status: c.state } });
    if (match[2] === 'start') {
      if (c.state === 'running') return json(304);
      c.state = 'running';
    } else if (match[2] === 'stop') {
      if (c.state !== 'running') return json(304);
      c.state = 'exited';
    } else c.state = 'running';
    return json(204);
  });
  return { containers, fetchImpl };
}

export interface Harness {
  bot: HomelabBot;
  config: Config;
  harmony: ReturnType<typeof recordingFetch>;
  docker: ReturnType<typeof fakeDocker>;
  ptero: ReturnType<typeof recordingFetch>;
  logs: string[];
  messages: { channel: string; content: string }[];
  followups: { content: string; ephemeral?: boolean }[];
  panels: Map<string, unknown>;
  powerCalls: { id: string; signal: string }[];
  /** Who holds which role: userId -> permission keys. */
  grants: Map<string, string[]>;
  clock: { now: number };
  ask: (interaction: Partial<InteractionPayload> & Record<string, unknown>) => Promise<{
    responses: unknown[];
    ctx: InteractionContext;
  }>;
}

export const GUILD = '1';
export const OPS = '30';
export const DASH = '20';

export function harness(
  options: {
    control?: string[];
    status?: string[];
    containers?: Record<string, FakeContainer>;
    games?: { id: string; name: string; state?: string }[];
    rolePermission?: string;
    cooldownSeconds?: number;
  } = {},
): Harness {
  const control = options.control ?? ['jellyfin', 'n8n'];
  const status = options.status ?? ['vaultwarden'];
  const config = buildConfig(
    {
      harmony: {
        url: 'http://harmony.invalid:8081',
        guildId: GUILD,
        opsChannel: 'ops',
        rolePermission: options.rolePermission,
      },
      docker: { proxyUrl: PROXY, control, status },
      pterodactyl: { url: PTERO },
      cooldownSeconds: options.cooldownSeconds ?? 30,
    },
    {
      HARMONY_BOT_TOKEN: TOKEN,
      PTERODACTYL_CLIENT_API_KEY: PTERO_KEY,
      DASHBOARD_CHANNEL: 'dashboard',
    },
  );
  const messages: Harness['messages'] = [];
  const followups: Harness['followups'] = [];
  const panels = new Map<string, unknown>();
  const powerCalls: Harness['powerCalls'] = [];
  const grants = new Map<string, string[]>([
    ['10', ['manage_guild']],
    ['11', []],
  ]);
  const games = options.games ?? [{ id: 'abcd1234', name: 'Core Keeper', state: 'running' }];

  const docker = fakeDocker(
    options.containers ?? {
      jellyfin: { state: 'running' },
      n8n: { state: 'exited' },
      vaultwarden: { state: 'running' },
    },
  );
  const ptero = recordingFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === '/api/client') {
      return json(200, {
        data: games.map((g) => ({
          attributes: { identifier: g.id, name: g.name, is_suspended: false },
        })),
        meta: { pagination: { total_pages: 1 } },
      });
    }
    const res = /^\/api\/client\/servers\/([a-z0-9]{8})\/(resources|power)$/.exec(url.pathname);
    if (res?.[2] === 'power') {
      powerCalls.push({ id: res[1] ?? '', signal: (call.body as { signal: string }).signal });
      return json(204);
    }
    if (res?.[2] === 'resources') {
      const g = games.find((x) => x.id === res[1]);
      return json(200, {
        attributes: {
          current_state: g?.state ?? 'offline',
          resources: {
            cpu_absolute: 12.4,
            memory_bytes: 2 * 1024 ** 3,
            memory_limit_bytes: 4 * 1024 ** 3,
            uptime: 3_600_000,
          },
        },
      });
    }
    return json(404);
  });
  const clock = { now: 1_000_000 };
  const harmony = recordingFetch((call) => {
    const url = new URL(call.url);
    const p = url.pathname;
    if (p === '/api/guilds') return json(200, { guilds: [{ id: GUILD, ownerId: '99' }] });
    if (p === `/api/guilds/${GUILD}/channels`) {
      return json(200, {
        channels: [
          { id: DASH, name: 'dashboard', kind: 'dashboard' },
          { id: OPS, name: 'ops', kind: 'text' },
        ],
      });
    }
    if (p === `/api/guilds/${GUILD}/roles`) {
      return json(200, {
        roles: [
          { id: '5', isDefault: false, permissions: ['manage_guild'] },
          { id: '1', isDefault: true, permissions: ['view_channel'] },
        ],
      });
    }
    if (p === `/api/guilds/${GUILD}/members`) {
      return json(200, {
        members: [...grants.keys()].map((id) => ({
          id,
          roleIds: grants.get(id)?.includes('manage_guild') ? ['5'] : [],
        })),
      });
    }
    if (call.method === 'PUT' && p.startsWith(`/api/channels/${DASH}/panels/`)) {
      panels.set(p.split('/').pop() ?? '', (call.body as { view: unknown }).view);
      return json(200, {});
    }
    if (call.method === 'GET' && p === `/api/channels/${DASH}/panels`)
      return json(200, { panels: [] });
    if (call.method === 'POST' && p === `/api/channels/${OPS}/messages`) {
      messages.push({ channel: OPS, content: (call.body as { content: string }).content });
      return json(201, {});
    }
    if (call.method === 'POST' && p.includes('/followup')) {
      followups.push(call.body as { content: string });
      return json(201, { messageId: null });
    }
    if (call.method === 'PUT' && p.includes('/commands')) return json(200, {});
    return json(404, { error: 'unexpected' });
  });

  const api = new HarmonyApi(config.harmony.url, TOKEN, harmony);
  const logs: string[] = [];
  const cooldown = new Cooldown(config.cooldownSeconds * 1000, () => clock.now);
  const bot = new HomelabBot({
    config,
    api,
    docker: new DockerClient(PROXY, config.docker, docker.fetchImpl),
    pterodactyl: new PterodactylClient(PTERO, PTERO_KEY, ptero),
    permissions: {
      has: (userId, permission) =>
        Promise.resolve(grants.get(userId)?.includes(permission) ?? false),
    },
    log: (line) => logs.push(line),
    now: () => new Date('2026-10-29T14:05:09Z'),
    cooldown,
  });

  let n = 100;
  const ask: Harness['ask'] = async (partial) => {
    const responses: unknown[] = [];
    const interaction = {
      id: String(n++),
      token: 'interaction-token-abcdef',
      guildId: GUILD,
      channelId: DASH,
      user: { id: '10', login: 'ada@example.com', displayName: 'Ada' },
      createdAt: '2026-10-29T14:05:09.000Z',
      expiresAt: '2026-10-29T14:20:09.000Z',
      ...partial,
    } as InteractionPayload;
    const ctx = new InteractionContext(interaction, (r) => responses.push(r), api);
    await bot.handle(ctx);
    return { responses, ctx };
  };

  return {
    bot,
    config,
    harmony,
    docker,
    ptero,
    logs,
    messages,
    followups,
    panels,
    powerCalls,
    grants,
    clock,
    ask,
  };
}

export const action = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'action' as const,
  action: { id, source: { kind: 'panel' as const, panelId: '4', key: 'containers' } },
  ...extra,
});

export const command = (
  name: string,
  options: Record<string, string | number | boolean> = {},
  extra: Record<string, unknown> = {},
) => ({
  type: 'command' as const,
  command: { name, options },
  ...extra,
});
