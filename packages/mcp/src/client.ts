import { ChannelSummary, GuildSummary, Message } from '@harmony/shared';
import { z } from 'zod';
import WebSocket from 'ws';

/** An error answer from Harmony (`{code, message}` with an HTTP status) or a transport failure. */
export class HarmonyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'HarmonyError';
  }
}

export interface ClientOptions {
  /** Base URL such as `http://127.0.0.1:8471`. */
  url: string;
  /** Bot token (`hb_<botId>_<secret>`). Sent only as the `Authorization` header. */
  token: string;
  requestTimeoutMs?: number;
}

export interface WaitOptions {
  channelId: string;
  /** Only messages with a larger id count. Defaults to the channel's newest message at call time. */
  afterMessageId?: string;
  timeoutMs: number;
  accept: (message: Message) => boolean;
  signal?: AbortSignal;
  /** Consecutive failed socket connections before switching to REST polling. */
  maxSocketFailures?: number;
  pollIntervalMs?: number;
  reconnectBaseMs?: number;
}

export interface WaitResult {
  message: Message | null;
  transport: 'websocket' | 'polling';
  reconnects: number;
  cancelled: boolean;
}

const MessagesPage = z.object({ messages: z.array(Message), hasMore: z.boolean() });
const GuildsResponse = z.object({ guilds: z.array(GuildSummary) });
const ChannelsResponse = z.object({ channels: z.array(ChannelSummary) });

/** Numeric ids compare by value; they are bigints on the server. */
export function idGreater(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done);
  });

/** Small typed REST and WebSocket client for the bot API (see docs/api/protocol.md). */
export class HarmonyClient {
  readonly botId: string;
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
    const match = /^hb_(\d+)_/.exec(options.token);
    if (!match?.[1]) throw new Error('Not a Harmony bot token');
    this.botId = match[1];
  }

  private async request(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<unknown> {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          ...(options.body !== undefined && { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'error';
      throw new HarmonyError(
        0,
        reason === 'TimeoutError' ? 'timeout' : 'unreachable',
        `Could not reach Harmony at ${this.base} (${reason}).`,
      );
    }
    if (res.status === 204) return undefined;
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const body = (json ?? {}) as { code?: unknown; message?: unknown };
      const retry = Number(res.headers.get('retry-after'));
      throw new HarmonyError(
        res.status,
        typeof body.code === 'string' ? body.code : `http_${res.status}`,
        typeof body.message === 'string' ? body.message : `HTTP ${res.status}`,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    }
    return json;
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new HarmonyError(502, 'bad_response', 'Harmony answered with an unexpected shape.');
    }
    return parsed.data;
  }

  async listGuilds(): Promise<GuildSummary[]> {
    return this.parse(GuildsResponse, await this.request('GET', '/api/guilds')).guilds;
  }

  async listGuildChannels(guildId: string): Promise<ChannelSummary[]> {
    const body = await this.request('GET', `/api/guilds/${guildId}/channels`);
    return this.parse(ChannelsResponse, body).channels;
  }

  /** Every channel the bot is in, across guilds. */
  async listChannels(): Promise<ChannelSummary[]> {
    return this.parse(ChannelsResponse, await this.request('GET', '/api/channels')).channels;
  }

  /** Oldest first, like the REST endpoint. */
  async getMessages(
    channelId: string,
    query: { before?: string; limit?: number } = {},
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    return this.parse(
      MessagesPage,
      await this.request('GET', `/api/channels/${channelId}/messages`, { query }),
    );
  }

  async sendMessage(
    channelId: string,
    input: { content: string; replyToId?: string },
  ): Promise<Message> {
    const body = await this.request('POST', `/api/channels/${channelId}/messages`, {
      body: { content: input.content, replyToId: input.replyToId },
    });
    return this.parse(Message, body);
  }

  async addReaction(messageId: string, emoji: string): Promise<void> {
    await this.request('PUT', `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }

  /** Newest first, like the REST endpoint. */
  async search(
    q: string,
    query: { channelId?: string; before?: string; limit?: number } = {},
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    return this.parse(
      MessagesPage,
      await this.request('GET', '/api/search', { query: { q, ...query } }),
    );
  }

  private wsUrl(): string {
    const url = new URL(this.base + '/api/ws');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  /**
   * Waits for the first message that `accept` approves, newer than `afterMessageId`. Uses the
   * gateway (bot auth on the upgrade), re-subscribes with `lastSeenId` after a drop so nothing is
   * lost, and falls back to polling REST when the socket keeps failing. A timeout is a normal
   * result (`message: null`), not an error. Auth and permission failures throw.
   */
  async waitForMessage(options: WaitOptions): Promise<WaitResult> {
    const { channelId, signal } = options;
    const deadline = Date.now() + options.timeoutMs;
    const maxFailures = options.maxSocketFailures ?? 3;
    const pollMs = options.pollIntervalMs ?? 2000;
    const backoffBase = options.reconnectBaseMs ?? 500;
    const seen = new Set<string>();

    let lastSeen =
      options.afterMessageId ??
      (await this.getMessages(channelId, { limit: 1 })).messages.at(-1)?.id ??
      '0';
    const floor = lastSeen;
    let reconnects = 0;
    let failures = 0;
    let transport: WaitResult['transport'] = 'websocket';

    /** Returns the message when it is the one we are waiting for. */
    const consider = (message: Message): Message | null => {
      if (message.channelId !== channelId || seen.has(message.id)) return null;
      if (!idGreater(message.id, floor)) return null;
      seen.add(message.id);
      if (idGreater(message.id, lastSeen)) lastSeen = message.id;
      return !message.deleted && options.accept(message) ? message : null;
    };

    const poll = async (): Promise<Message | null> => {
      const page = await this.getMessages(channelId, { limit: 50 });
      for (const message of page.messages) {
        const hit = consider(message);
        if (hit) return hit;
      }
      return null;
    };

    const result = (message: Message | null, cancelled = false): WaitResult => ({
      message,
      transport,
      reconnects,
      cancelled,
    });

    while (Date.now() < deadline) {
      if (signal?.aborted) return result(null, true);
      if (failures >= maxFailures) {
        transport = 'polling';
        const hit = await poll();
        if (hit) return result(hit);
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
        continue;
      }
      const session = await this.socketSession({
        channelId,
        lastSeenId: lastSeen,
        deadline,
        signal,
        consider,
        catchUp: poll,
      });
      if (session.kind === 'match') return result(session.message);
      if (session.kind === 'timeout') return result(null);
      if (session.kind === 'aborted') return result(null, true);
      failures = session.connected ? 0 : failures + 1;
      reconnects += 1;
      const backoff = Math.min(backoffBase * 2 ** Math.min(failures, 4), 5000);
      await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())), signal);
    }
    return result(null);
  }

  private socketSession(args: {
    channelId: string;
    lastSeenId: string;
    deadline: number;
    signal: AbortSignal | undefined;
    consider: (message: Message) => Message | null;
    catchUp: () => Promise<Message | null>;
  }): Promise<
    | { kind: 'match'; message: Message }
    | { kind: 'timeout' }
    | { kind: 'aborted' }
    | { kind: 'closed'; connected: boolean }
  > {
    return new Promise((resolve, reject) => {
      let connected = false;
      let settled = false;
      const ws = new WebSocket(this.wsUrl(), { headers: { authorization: `Bot ${this.token}` } });

      const finish = (outcome: Parameters<typeof resolve>[0]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        args.signal?.removeEventListener('abort', onAbort);
        ws.removeAllListeners();
        ws.on('error', () => undefined);
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close();
        resolve(outcome);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        args.signal?.removeEventListener('abort', onAbort);
        ws.removeAllListeners();
        ws.on('error', () => undefined);
        ws.terminate();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onAbort = () => finish({ kind: 'aborted' });
      const timer = setTimeout(
        () => finish({ kind: 'timeout' }),
        Math.max(0, args.deadline - Date.now()),
      );
      args.signal?.addEventListener('abort', onAbort);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            channelId: args.channelId,
            lastSeenId: args.lastSeenId === '0' ? undefined : args.lastSeenId,
          }),
        );
      });
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status === 401 || status === 403) {
          fail(
            new HarmonyError(
              status,
              status === 401 ? 'invalid_token' : 'forbidden',
              'The gateway refused the bot token.',
            ),
          );
        } else finish({ kind: 'closed', connected });
      });
      ws.on('error', () => finish({ kind: 'closed', connected }));
      ws.on('close', () => finish({ kind: 'closed', connected }));
      ws.on('message', (data) => {
        let frame: {
          type?: string;
          code?: string;
          message?: unknown;
          messages?: unknown;
          hasMore?: boolean;
        };
        try {
          frame = JSON.parse((data as Buffer).toString('utf8')) as typeof frame;
        } catch {
          return;
        }
        if (frame.type === 'error') {
          const code = frame.code ?? 'error';
          if (code === 'rate_limited') return;
          const text = typeof frame.message === 'string' ? frame.message : code;
          fail(
            new HarmonyError(
              code === 'forbidden' || code === 'missing_scope' ? 403 : 400,
              code,
              text,
            ),
          );
          return;
        }
        if (frame.type === 'backfill') {
          connected = true;
          const parsed = z.array(Message).safeParse(frame.messages);
          for (const message of parsed.success ? parsed.data : []) {
            const hit = args.consider(message);
            if (hit) return finish({ kind: 'match', message: hit });
          }
          if (frame.hasMore) {
            args
              .catchUp()
              .then((hit) => (hit ? finish({ kind: 'match', message: hit }) : undefined), fail);
          }
          return;
        }
        if (frame.type === 'message.created') {
          const parsed = Message.safeParse(frame.message);
          if (!parsed.success) return;
          const hit = args.consider(parsed.data);
          if (hit) finish({ kind: 'match', message: hit });
        }
      });
    });
  }
}
