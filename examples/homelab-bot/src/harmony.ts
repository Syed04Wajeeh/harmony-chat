import { readFileSync, writeFileSync } from 'node:fs';
import type { InteractionPayload, InteractionResponse, PanelView } from '@harmony/shared';

export type Log = (message: string) => void;
type WebSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

export class HarmonyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The REST half. The bot token is the only credential and never leaves the Authorization header. */
export class HarmonyApi {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    { bot = true }: { bot?: boolean } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: {
          ...(bot && { authorization: `Bot ${this.token}` }),
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HarmonyError(0, `${method} ${path}: Harmony did not answer`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new HarmonyError(res.status, `${method} ${path} -> ${String(res.status)} ${detail}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  guilds() {
    return this.request<{ guilds: { id: string; ownerId: string }[] }>('GET', '/api/guilds').then(
      (r) => r.guilds,
    );
  }
  channels(guildId: string) {
    return this.request<{ channels: { id: string; name: string | null; kind: string }[] }>(
      'GET',
      `/api/guilds/${guildId}/channels`,
    ).then((r) => r.channels);
  }
  roles(guildId: string) {
    return this.request<{ roles: { id: string; isDefault: boolean; permissions: string[] }[] }>(
      'GET',
      `/api/guilds/${guildId}/roles`,
    ).then((r) => r.roles);
  }
  members(guildId: string) {
    return this.request<{ members: { id: string; roleIds: string[] }[] }>(
      'GET',
      `/api/guilds/${guildId}/members`,
    ).then((r) => r.members);
  }
  botId(): string {
    return /^hb_(\d+)_/.exec(this.token)?.[1] ?? '';
  }
  putCommands(guildId: string, commands: unknown[]) {
    return this.request('PUT', `/api/bots/${this.botId()}/guilds/${guildId}/commands`, commands);
  }
  putPanel(channelId: string, key: string, view: PanelView) {
    return this.request('PUT', `/api/channels/${channelId}/panels/${key}`, { view, pinned: false });
  }
  listPanels(channelId: string) {
    return this.request<{ panels: { key: string; botId: string }[] }>(
      'GET',
      `/api/channels/${channelId}/panels`,
    ).then((r) => r.panels);
  }
  deletePanel(channelId: string, key: string) {
    return this.request('DELETE', `/api/channels/${channelId}/panels/${key}`);
  }
  sendMessage(channelId: string, content: string) {
    return this.request('POST', `/api/channels/${channelId}/messages`, { content });
  }
  /** Follow-up to a deferred interaction; the interaction token in the path is the credential. */
  followup(
    interaction: { id: string; token: string },
    message: { content: string; ephemeral?: boolean },
  ) {
    return this.request(
      'POST',
      `/api/interactions/${interaction.id}/${encodeURIComponent(interaction.token)}/followup`,
      message,
      { bot: false },
    );
  }
}

/** Answers one interaction. The first call is the real answer; later calls are follow-ups. */
export class InteractionContext {
  private answered: 'no' | 'deferred' | 'replied' = 'no';

  readonly interaction: InteractionPayload;
  private readonly send: (response: InteractionResponse) => void;
  private readonly api: HarmonyApi;

  constructor(
    interaction: InteractionPayload,
    send: (response: InteractionResponse) => void,
    api: HarmonyApi,
  ) {
    this.interaction = interaction;
    this.send = send;
    this.api = api;
  }

  get isAnswered(): boolean {
    return this.answered !== 'no';
  }

  /** Acknowledge within the deadline; the real answer follows through `say`. */
  defer(): void {
    if (this.answered !== 'no') return;
    this.answered = 'deferred';
    this.send({ type: 'deferred' });
  }

  /** The answer: direct if nothing has been sent yet, otherwise a follow-up. Ephemeral by default. */
  async say(content: string, ephemeral = true): Promise<void> {
    const text = content.slice(0, 1900);
    if (this.answered === 'no') {
      this.answered = 'replied';
      this.send({ type: 'message', content: text, ephemeral });
      return;
    }
    this.answered = 'replied';
    await this.api.followup(this.interaction, { content: text, ephemeral });
  }
}

export interface GatewayOptions {
  url: string;
  token: string;
  seqFile?: string | undefined;
  /** Seconds between keepalive probes; 0 turns them off. */
  keepaliveSeconds?: number;
  /** Interactions not answered within this many ms are answered `deferred` automatically. */
  deadlineMs?: number;
  log: Log;
  api: HarmonyApi;
  onInteraction: (context: InteractionContext) => Promise<void>;
  /** Injected in tests. */
  WebSocketImpl?: WebSocketConstructor;
}

/**
 * The gateway connection: reconnects with backoff, resumes from the last event number, hands each
 * interaction to the handler and makes sure it is answered inside the server's deadline.
 */
export class Gateway {
  private lastSeq = 0;
  private delayMs = 1000;
  private socket: WebSocket | undefined;
  private stopped = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private probe: ReturnType<typeof setInterval> | undefined;
  private lastHeard = 0;
  private readonly seen = new Set<string>();

  private readonly options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.options = options;
    try {
      if (options.seqFile) this.lastSeq = Number(readFileSync(options.seqFile, 'utf8')) || 0;
    } catch {
      // first run
    }
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    if (this.probe) clearInterval(this.probe);
    this.socket?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const { log } = this.options;
    const url = `${this.options.url.replace(/^http/, 'ws')}/api/ws`;
    // Node's built-in WebSocket takes a headers option, which the Bot credential needs.
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const ws = new Impl(url, { headers: { authorization: `Bot ${this.options.token}` } });
    this.socket = ws;
    const send = (frame: unknown) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(frame));
    };

    ws.addEventListener('message', (message) => {
      this.lastHeard = Date.now();
      let frame: { type: string; [key: string]: unknown };
      try {
        frame = JSON.parse(String(message.data)) as typeof frame;
      } catch {
        return;
      }
      switch (frame.type) {
        case 'hello':
          this.delayMs = 1000;
          log(`connected to the gateway, resuming after ${String(this.lastSeq)}`);
          send({ type: 'resume', lastSeq: this.lastSeq });
          this.startKeepalive(ws, send);
          break;
        case 'interaction.create':
          void this.handle(frame.interaction as InteractionPayload, send);
          break;
        case 'event': {
          const seq = Number(frame.seq);
          if (seq > this.lastSeq) {
            this.lastSeq = seq;
            if (this.options.seqFile) writeFileSync(this.options.seqFile, String(seq));
          }
          send({ type: 'event.ack', seq });
          break;
        }
        case 'error':
          log(`gateway error ${String(frame.code)}`);
          if (frame.code === 'missing_scope' && this.probe) {
            // Without the events scope `resume` is refused, so it cannot double as a probe.
            log('the bot has no events scope: resume and keepalive probes are off');
            clearInterval(this.probe);
            this.probe = undefined;
          }
          break;
      }
    });
    ws.addEventListener('close', () => {
      if (this.probe) clearInterval(this.probe);
      if (this.stopped) return;
      log(`gateway closed, reconnecting in ${String(this.delayMs)} ms`);
      this.timers.push(setTimeout(() => this.connect(), this.delayMs));
      // Backoff with jitter so a restarted server is not hit by every client at once.
      this.delayMs = Math.min(this.delayMs * 2, 30_000);
    });
    ws.addEventListener('error', () => undefined); // 'close' follows
  }

  /** A `resume` is answered with `resumed`: a cheap probe that notices a half-open socket. */
  private startKeepalive(ws: WebSocket, send: (frame: unknown) => void): void {
    const seconds = this.options.keepaliveSeconds ?? 45;
    if (this.probe) clearInterval(this.probe);
    if (seconds <= 0) return;
    this.lastHeard = Date.now();
    this.probe = setInterval(() => {
      if (Date.now() - this.lastHeard > seconds * 2000) {
        this.options.log('gateway went silent, reconnecting');
        ws.close();
        return;
      }
      send({ type: 'resume', lastSeq: this.lastSeq });
    }, seconds * 1000);
    this.probe.unref();
  }

  private async handle(
    interaction: InteractionPayload,
    send: (frame: unknown) => void,
  ): Promise<void> {
    if (this.seen.has(interaction.id)) return;
    this.seen.add(interaction.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string);

    const context = new InteractionContext(
      interaction,
      (response) =>
        send({
          type: 'interaction.respond',
          interactionId: interaction.id,
          token: interaction.token,
          response,
        }),
      this.options.api,
    );
    // Whatever the handler does, the server hears something before its deadline.
    const watchdog = setTimeout(() => context.defer(), this.options.deadlineMs ?? 2200);
    try {
      await this.options.onInteraction(context);
    } catch (error) {
      this.options.log(
        `interaction ${interaction.id} failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      await context
        .say('Something went wrong; the details are in the bot log.')
        .catch(() => undefined);
    } finally {
      clearTimeout(watchdog);
    }
  }
}
