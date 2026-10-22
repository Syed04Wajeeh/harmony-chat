// Shared helpers for the load-test scripts. Node 24 runs this TypeScript directly (type stripping).
//
// Identity: the load stack's nginx is the production user proxy, which stamps the proxy secret and
// passes `Tailscale-*` headers through. Tailscale Serve is not part of the load path, so these
// helpers send `Tailscale-User-Login` and the right Origin themselves, exactly what Serve would
// have put on the request.
import { WebSocket } from 'ws';

export const BASE = process.env.HARMONY_BASE ?? 'http://127.0.0.1:8570';
export const ORIGIN = process.env.HARMONY_ORIGIN ?? 'https://load.example.test';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const loginFor = (prefix: string, n: number): string => `load-${prefix}-${n}@example.com`;

export function headersFor(
  login: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { 'tailscale-user-login': login, origin: ORIGIN, ...extra };
}

export async function api<T = unknown>(
  login: string,
  method: string,
  path: string,
  body?: unknown,
  base: string = BASE,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: headersFor(login, body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<void>,
) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

export function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? NaN,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.length ? sum / sorted.length : NaN,
  };
}

export interface Frame {
  type: string;
  [key: string]: unknown;
}

export interface MessageDto {
  id: string;
  channelId: string;
  content: string;
}

/** A WebSocket client that records every frame, with promise helpers for tests. */
export class Client {
  ws!: WebSocket;
  instanceId = '';
  frames: Frame[] = [];
  closedAt: number | null = null;
  private waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  /** Called for every received frame, before it is stored. */
  onFrame: ((frame: Frame, receivedAt: number) => void) | null = null;
  keepFrames = true;

  readonly login: string;
  readonly base: string;

  constructor(login: string, base: string = BASE) {
    this.login = login;
    this.base = base;
  }

  /** Opens the socket and resolves on the `hello` frame, or rejects on error/close/timeout. */
  connect(timeoutMs = 10_000): Promise<void> {
    const url = `${this.base.replace(/^http/, 'ws')}/api/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: headersFor(this.login) });
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('connect timeout'));
      }, timeoutMs);
      ws.on('message', (data) => {
        const receivedAt = Date.now();
        const frame = JSON.parse((data as Buffer).toString('utf8')) as Frame;
        if (frame.type === 'hello') {
          this.instanceId = String(frame.instanceId);
          clearTimeout(timer);
          resolve();
        }
        this.onFrame?.(frame, receivedAt);
        if (this.keepFrames) this.frames.push(frame);
        for (const w of [...this.waiters]) {
          if (w.match(frame)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(frame);
          }
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`upgrade rejected: ${res.statusCode}`));
      });
      ws.on('close', () => {
        this.closedAt = Date.now();
        clearTimeout(timer);
        reject(new Error('closed before hello'));
      });
    });
  }

  send(frame: object): void {
    this.ws.send(JSON.stringify(frame));
  }

  waitFor(match: (f: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (f: Frame) => (clearTimeout(timer), resolve(f)) };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error('waitFor timeout'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** Subscribe and wait for the matching backfill frame (the subscription confirmation). */
  async subscribe(channelId: string, lastSeenId?: string, timeoutMs = 10_000): Promise<Frame> {
    const start = this.frames.length;
    this.send({ type: 'subscribe', channelId, ...(lastSeenId && { lastSeenId }) });
    return await new Promise<Frame>((resolve, reject) => {
      const check = (f: Frame) => f.type === 'backfill' && f.channelId === channelId;
      const seen = this.frames.slice(start).find(check);
      if (seen) return resolve(seen);
      const w = { match: check, resolve: (f: Frame) => (clearTimeout(timer), resolve(f)) };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error('subscribe timeout'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

export interface World {
  prefix: string;
  groups: { guildId: string; channelId: string; logins: string[] }[];
}

/**
 * Creates `groups` guilds of `members` users each through the REST API: the first user of each
 * group creates the guild and an invite, the others accept it. Users are numbered globally.
 */
export async function buildWorld(opts: {
  prefix: string;
  groups: number;
  members: number;
  concurrency?: number;
}): Promise<World> {
  const { prefix, groups, members, concurrency = 16 } = opts;
  const world: World = { prefix, groups: [] };
  const ownerIdx = Array.from({ length: groups }, (_, g) => g);
  const created: { guildId: string; channelId: string; code: string }[] = [];
  await pool(ownerIdx, concurrency, async (g) => {
    const owner = loginFor(prefix, g * members);
    const guild = await api<{ id: string }>(owner, 'POST', '/api/guilds', {
      name: `load-${prefix}-${g}`,
    });
    const channels = await api<{ channels: { id: string; name: string }[] }>(
      owner,
      'GET',
      `/api/guilds/${guild.id}/channels`,
    );
    const channelId = (channels.channels.find((c) => c.name === 'general') ?? channels.channels[0])
      ?.id;
    if (!channelId) throw new Error('no channel in new guild');
    const invite = await api<{ code: string }>(owner, 'POST', `/api/guilds/${guild.id}/invites`, {
      maxUses: Math.min(1000, Math.max(1, members)),
    });
    created[g] = { guildId: guild.id, channelId, code: invite.code };
  });
  const joins: { g: number; n: number }[] = [];
  for (let g = 0; g < groups; g++)
    for (let m = 1; m < members; m++) joins.push({ g, n: g * members + m });
  await pool(joins, concurrency, async ({ g, n }) => {
    await api(loginFor(prefix, n), 'POST', `/api/invites/${created[g]?.code}/accept`);
  });
  for (let g = 0; g < groups; g++) {
    const c = created[g] as { guildId: string; channelId: string };
    world.groups.push({
      guildId: c.guildId,
      channelId: c.channelId,
      logins: Array.from({ length: members }, (_, m) => loginFor(prefix, g * members + m)),
    });
  }
  return world;
}
