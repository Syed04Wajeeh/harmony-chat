import { BotError, clean } from './errors.ts';
import type { Verb } from './docker.ts';

export interface GameServer {
  /** The short identifier the client API uses in URLs (8 hex characters). */
  id: string;
  name: string;
  suspended: boolean;
}

export interface GameResources {
  /** running, starting, stopping or offline; `unknown` when the daemon did not answer. */
  state: string;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitMb: number;
  /** Milliseconds, 0 while offline. */
  uptimeMs: number;
}

const SERVER_ID = /^[a-z0-9]{8}$/;

/**
 * Pterodactyl's client API (a user API key, not the admin one). Only list, resources and the three
 * power signals are implemented; `kill` is deliberately absent.
 */
export class PterodactylClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/client${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new BotError('unreachable', 'The game panel did not answer.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new BotError('refused', 'The game panel rejected the bot’s API key.');
    }
    if (res.status === 404) throw new BotError('not_found', 'The game server was not found.');
    if (res.status === 409) {
      throw new BotError(
        'failed',
        'The game server is busy (installing, transferring or suspended).',
      );
    }
    if (res.status === 429)
      throw new BotError('failed', 'The game panel is rate limiting the bot.');
    if (!res.ok) throw new BotError('failed', `The game panel said no (${String(res.status)}).`);
    if (res.status === 204) return undefined;
    const data: unknown = await res.json();
    return data;
  }

  async listServers(): Promise<GameServer[]> {
    const servers: GameServer[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = (await this.call('GET', `?page=${String(page)}&per_page=50`)) as {
        data?: { attributes?: { identifier?: string; name?: string; is_suspended?: boolean } }[];
        meta?: { pagination?: { total_pages?: number } };
      };
      for (const item of body.data ?? []) {
        const a = item.attributes;
        if (a?.identifier && SERVER_ID.test(a.identifier)) {
          servers.push({
            id: a.identifier,
            name: clean(a.name, 60) || a.identifier,
            suspended: a.is_suspended === true,
          });
        }
      }
      if (page >= (body.meta?.pagination?.total_pages ?? 1)) break;
    }
    return servers;
  }

  private id(id: string): string {
    if (!SERVER_ID.test(id)) throw new BotError('not_found', 'That is not a game server id.');
    return id;
  }

  async resources(id: string): Promise<GameResources> {
    const body = (await this.call('GET', `/servers/${this.id(id)}/resources`)) as {
      attributes?: {
        current_state?: string;
        resources?: {
          cpu_absolute?: number;
          memory_bytes?: number;
          memory_limit_bytes?: number;
          uptime?: number;
        };
      };
    };
    const a = body.attributes;
    return {
      state: clean(a?.current_state, 20) || 'unknown',
      cpuPercent: a?.resources?.cpu_absolute ?? 0,
      memoryBytes: a?.resources?.memory_bytes ?? 0,
      memoryLimitMb: Math.round((a?.resources?.memory_limit_bytes ?? 0) / 1024 / 1024),
      uptimeMs: a?.resources?.uptime ?? 0,
    };
  }

  async power(id: string, signal: Verb): Promise<void> {
    if (signal !== 'start' && signal !== 'stop' && signal !== 'restart') {
      throw new BotError('not_allowed', 'That power action is not allowed.');
    }
    await this.call('POST', `/servers/${this.id(id)}/power`, { signal });
  }
}
