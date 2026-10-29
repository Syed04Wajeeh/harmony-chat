import {
  ChannelSummary,
  GuildSummary,
  Message,
  Panel,
  type InteractionPayload,
  type MessageComponents,
  type PanelView,
} from '@harmony/shared';
import { z } from 'zod';
import type WebSocket from 'ws';
import { GatewayLink } from './gateway.js';

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

/** What a bot answers to an interaction (a subset of the protocol's `InteractionResponse`). */
export type InteractionAnswer =
  { type: 'message'; content: string; ephemeral: boolean } | { type: 'deferred' };

export type InteractionHandler = (
  interaction: InteractionPayload,
) => InteractionAnswer | Promise<InteractionAnswer>;

const PanelsResponse = z.object({ panels: z.array(Panel) });
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
    input: { content: string; replyToId?: string; components?: MessageComponents },
  ): Promise<Message> {
    const body = await this.request('POST', `/api/channels/${channelId}/messages`, {
      body: {
        content: input.content,
        replyToId: input.replyToId,
        ...(input.components && { components: input.components }),
      },
    });
    return this.parse(Message, body);
  }

  /** Edits one of the bot's own messages; `clearComponents` removes its buttons. */
  async editMessage(
    messageId: string,
    content: string,
    options: { clearComponents?: boolean } = {},
  ): Promise<Message> {
    const body = await this.request('PATCH', `/api/messages/${messageId}`, {
      body: { content, ...(options.clearComponents && { components: null }) },
    });
    return this.parse(Message, body);
  }

  async putPanel(channelId: string, key: string, view: PanelView): Promise<Panel> {
    const body = await this.request('PUT', `/api/channels/${channelId}/panels/${key}`, {
      body: { view },
    });
    return this.parse(Panel, body);
  }

  async deletePanel(channelId: string, key: string): Promise<void> {
    await this.request('DELETE', `/api/channels/${channelId}/panels/${key}`);
  }

  async listPanels(channelId: string): Promise<Panel[]> {
    return this.parse(
      PanelsResponse,
      await this.request('GET', `/api/channels/${channelId}/panels`),
    ).panels;
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

  private interactionHandler: InteractionHandler | undefined;
  private link: GatewayLink | undefined;

  /** The process's single gateway socket, created on first use (see `GatewayLink`). */
  get gateway(): GatewayLink {
    this.link ??= new GatewayLink(this.wsUrl(), this.token, (ws, interaction) =>
      this.answerInteraction(ws, interaction),
    );
    return this.link;
  }

  /** Closes the gateway socket now; used when the MCP client goes away. */
  closeGateway(): void {
    this.link?.shutdown();
  }

  /** Where `interaction.create` frames (button clicks) are answered; see `holdGateway`. */
  setInteractionHandler(handler: InteractionHandler | undefined): void {
    this.interactionHandler = handler;
  }

  /** Answers an `interaction.create` frame on the socket it arrived on. Never throws. */
  private answerInteraction(ws: WebSocket, interaction: InteractionPayload): void {
    const handler = this.interactionHandler;
    const reply = (response: InteractionAnswer) => {
      if (ws.readyState !== 1) return;
      ws.send(
        JSON.stringify({
          type: 'interaction.respond',
          interactionId: interaction.id,
          token: interaction.token,
          response,
        }),
      );
    };
    if (!handler) return reply({ type: 'deferred' });
    Promise.resolve()
      .then(() => handler(interaction))
      .then(reply, () =>
        reply({
          type: 'message',
          content: 'Something went wrong in the agent. Try again.',
          ephemeral: true,
        }),
      );
  }

  /**
   * Says the gateway socket is needed so button clicks reach this process while something
   * waits for them (a pending approval, a run with Cancel). Resolves once the socket is open or
   * after `waitMs`; a click before then reports `unreachable` to the person who made it.
   */
  async holdGateway(waitMs = 3000): Promise<() => void> {
    const link = this.gateway;
    const release = link.acquire();
    const deadline = Date.now() + waitMs;
    while (!link.isOpen && Date.now() < deadline) await sleep(25);
    return release;
  }

  private wsUrl(): string {
    const url = new URL(this.base + '/api/ws');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  /**
   * Waits for the first message that `accept` approves, newer than `afterMessageId`, on the
   * shared gateway socket. A reconnect resubscribes from the newest id seen, so nothing is lost
   * across a drop, and when the socket keeps failing it polls REST instead. A timeout is a
   * normal result (`message: null`), not an error. Auth and permission failures throw.
   */
  async waitForMessage(options: WaitOptions): Promise<WaitResult> {
    const { channelId, signal } = options;
    const maxFailures = options.maxSocketFailures ?? 3;
    const pollMs = options.pollIntervalMs ?? 2000;
    const seen = new Set<string>();

    let lastSeen =
      options.afterMessageId ??
      (await this.getMessages(channelId, { limit: 1 })).messages.at(-1)?.id ??
      '0';
    const floor = lastSeen;
    const link = this.gateway;
    if (options.reconnectBaseMs !== undefined) link.backoffBaseMs = options.reconnectBaseMs;
    const reconnectsBefore = link.reconnects;
    let transport: WaitResult['transport'] = 'websocket';

    const consider = (message: Message): Message | null => {
      if (message.channelId !== channelId || seen.has(message.id)) return null;
      if (!idGreater(message.id, floor)) return null;
      seen.add(message.id);
      if (idGreater(message.id, lastSeen)) lastSeen = message.id;
      return !message.deleted && options.accept(message) ? message : null;
    };

    const release = link.acquire();
    let unwatch = (): void => undefined;
    let removeListener = (): void => undefined;
    let timers: NodeJS.Timeout[] = [];
    try {
      return await new Promise<WaitResult>((resolve, reject) => {
        let settled = false;
        const result = (message: Message | null, cancelled = false): WaitResult => ({
          message,
          transport,
          reconnects: link.reconnects - reconnectsBefore,
          cancelled,
        });
        const finish = (outcome: WaitResult) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        const catchUp = () => {
          this.getMessages(channelId, { limit: 50 }).then((page) => {
            for (const message of page.messages) {
              const hit = consider(message);
              if (hit) return finish(result(hit));
            }
          }, fail);
        };

        removeListener = link.addListener({
          channelId,
          onMessage: (message) => {
            const hit = consider(message);
            if (hit) finish(result(hit));
          },
          onGap: catchUp,
          onFatal: (code, message, status) => fail(new HarmonyError(status, code, message)),
        });
        const watch = link.watch(channelId, lastSeen);
        unwatch = watch.unwatch;
        // Someone else already holds this subscription, so there is no backfill for us.
        if (watch.already) catchUp();

        // Degraded: the socket never opens, so ask over REST.
        const poller = setInterval(() => {
          if (link.failures >= maxFailures) {
            transport = 'polling';
            catchUp();
          }
        }, pollMs);
        timers = [poller, setTimeout(() => finish(result(null)), options.timeoutMs)];
        if (signal?.aborted) finish(result(null, true));
        signal?.addEventListener('abort', () => finish(result(null, true)), { once: true });
      });
    } finally {
      for (const timer of timers) {
        clearInterval(timer);
        clearTimeout(timer);
      }
      removeListener();
      unwatch();
      release();
    }
  }
}
