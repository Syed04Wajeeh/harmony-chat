import { BotError, clean, notAllowed } from './errors.ts';

export type Verb = 'start' | 'stop' | 'restart';
export const VERBS: readonly Verb[] = ['start', 'stop', 'restart'];

export interface ContainerInfo {
  name: string;
  state: string;
  /** Docker's own words, such as "Up 3 hours (healthy)". */
  statusText: string;
  health: 'healthy' | 'unhealthy' | 'starting' | undefined;
  /** Whether the bot may start, stop and restart it (as opposed to only showing it). */
  control: boolean;
}

/** Container names Docker accepts; anything else never reaches a URL. */
export const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

interface ListItem {
  Names?: string[];
  State?: string;
  Status?: string;
}

/**
 * Talks to a docker-socket-proxy. The only requests it can make are the four below, and a
 * container it was not given in `control` or `status` is not returned, not inspected and
 * not controlled, whatever name a caller passes. The proxy enforces the same limits on its
 * side; this is the second lock.
 */
export class DockerClient {
  private readonly control: ReadonlySet<string>;
  private readonly visible: ReadonlySet<string>;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    baseUrl: string,
    lists: { control: readonly string[]; status: readonly string[] },
    fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    for (const name of [...lists.control, ...lists.status]) {
      if (!CONTAINER_NAME.test(name)) throw new Error(`"${name}" is not a valid container name`);
    }
    this.control = new Set(lists.control);
    this.visible = new Set([...lists.control, ...lists.status]);
  }

  /** Whether `name` may be started, stopped and restarted. */
  canControl(name: string): boolean {
    return this.control.has(name);
  }

  private async call(method: 'GET' | 'POST', path: string): Promise<Response> {
    try {
      return await this.fetchImpl(this.baseUrl + path, {
        method,
        signal: AbortSignal.timeout(method === 'POST' ? 45_000 : 8_000),
      });
    } catch {
      throw new BotError('unreachable', 'The Docker proxy did not answer.');
    }
  }

  private async fail(res: Response, name?: string): Promise<never> {
    if (res.status === 404)
      throw new BotError('not_found', `Container ${name ?? ''} does not exist.`);
    if (res.status === 403) {
      throw new BotError('refused', 'The Docker proxy refused that request.');
    }
    let reason = '';
    try {
      reason = clean(((await res.json()) as { message?: string }).message, 120);
    } catch {
      // not JSON
    }
    throw new BotError(
      'failed',
      `Docker said no (${String(res.status)})${reason ? `: ${reason}` : ''}.`,
    );
  }

  private toInfo(item: ListItem): ContainerInfo | undefined {
    const name = item.Names?.[0]?.replace(/^\//, '');
    if (!name || !this.visible.has(name)) return undefined;
    const statusText = clean(item.Status, 120);
    const health = /\((healthy|unhealthy|health: starting)\)/.exec(statusText)?.[1];
    return {
      name,
      state: clean(item.State, 20) || 'unknown',
      statusText,
      health: health === 'health: starting' ? 'starting' : (health as ContainerInfo['health']),
      control: this.control.has(name),
    };
  }

  /** Allowlisted containers only, in config order (control first), including stopped ones. */
  async list(): Promise<ContainerInfo[]> {
    const res = await this.call('GET', '/containers/json?all=1');
    if (!res.ok) return this.fail(res);
    const items = (await res.json()) as ListItem[];
    const byName = new Map<string, ContainerInfo>();
    for (const item of items) {
      const info = this.toInfo(item);
      if (info) byName.set(info.name, info);
    }
    const order = [...this.visible];
    return order.flatMap((name) => byName.get(name) ?? []);
  }

  async inspect(name: string): Promise<ContainerInfo> {
    if (!this.visible.has(name)) throw notAllowed(`Container ${clean(name, 40)}`);
    const res = await this.call('GET', `/containers/${encodeURIComponent(name)}/json`);
    if (!res.ok) return this.fail(res, name);
    const body = (await res.json()) as {
      State?: { Status?: string; Health?: { Status?: string }; Running?: boolean };
    };
    const health = body.State?.Health?.Status;
    return {
      name,
      state: clean(body.State?.Status, 20) || 'unknown',
      statusText: clean(body.State?.Status, 40),
      health:
        health === 'healthy' || health === 'unhealthy' || health === 'starting'
          ? health
          : undefined,
      control: this.control.has(name),
    };
  }

  /** Start, stop or restart. Throws `not_allowed` for anything not in the control list. */
  async act(verb: Verb, name: string): Promise<'done' | 'unchanged'> {
    if (!VERBS.includes(verb)) throw notAllowed(`The action ${clean(verb, 20)}`);
    if (!this.control.has(name)) throw notAllowed(`Container ${clean(name, 40)}`);
    const query = verb === 'restart' || verb === 'stop' ? '?t=10' : '';
    const res = await this.call('POST', `/containers/${encodeURIComponent(name)}/${verb}${query}`);
    if (res.status === 304) return 'unchanged'; // already started / already stopped
    if (!res.ok) return this.fail(res, name);
    return 'done';
  }
}

export const isRunning = (info: ContainerInfo): boolean => info.state === 'running';
