import { Message, type InteractionPayload } from '@harmony/shared';
import { z } from 'zod';
import WebSocket from 'ws';

export interface GatewayListener {
  channelId: string;
  /** A live or backfilled message in the channel. */
  onMessage(message: Message): void;
  /** Messages may have been missed (a backfill was cut short): catch up over REST. */
  onGap(): void;
  /** The gateway refused the token or the subscription. */
  onFatal(code: string, message: string, status: number): void;
}

interface Watched {
  /** Newest message id seen in the channel; a resubscribe resumes from here. */
  last: string;
  watchers: number;
}

const IDLE_CLOSE_MS = 1000;

const greater = (a: string, b: string) => BigInt(a) > BigInt(b);

/**
 * The one WebSocket this process holds to Harmony. It is opened when the first thing needs it
 * (a wait, a pending approval, a run with a Cancel button), shared by all of them, reconnected
 * with backoff while anything still needs it, and closed a moment after the last need goes away.
 * Every channel anyone watches is resubscribed after a reconnect with the newest id seen, so
 * nothing is lost across a drop; button clicks (`interaction.create`) are answered on it too.
 */
export class GatewayLink {
  /** Consecutive connection attempts that never opened; drives the polling fallback. */
  failures = 0;
  /** Reconnects scheduled so far, for callers that report them. */
  reconnects = 0;
  /** Sockets opened so far (a test and diagnostics hook). */
  opened = 0;
  backoffBaseMs = 500;

  private refs = 0;
  private ws: WebSocket | undefined;
  private open = false;
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private closeTimer: NodeJS.Timeout | undefined;
  private readonly watched = new Map<string, Watched>();
  private readonly subscribed = new Set<string>();
  private readonly listeners = new Set<GatewayListener>();
  private lastSubscribe: string | undefined;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly onInteraction: (ws: WebSocket, interaction: InteractionPayload) => void,
  ) {}

  get isOpen(): boolean {
    return this.open;
  }

  /** Says the socket is needed. Call the returned function when it is not any more. */
  acquire(): () => void {
    this.refs += 1;
    clearTimeout(this.closeTimer);
    if (this.stopped) {
      this.stopped = false;
      this.connect();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs -= 1;
      if (this.refs <= 0) {
        this.closeTimer = setTimeout(() => this.stop(), IDLE_CLOSE_MS);
        this.closeTimer.unref();
      }
    };
  }

  addListener(listener: GatewayListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribes to a channel (once per connection, however many watch it). Returns true when
   * someone already watched it, so the caller should catch up over REST instead of expecting a
   * backfill from this subscription.
   */
  watch(channelId: string, lastSeenId: string): { already: boolean; unwatch: () => void } {
    const existing = this.watched.get(channelId);
    if (existing) existing.watchers += 1;
    else this.watched.set(channelId, { last: lastSeenId, watchers: 1 });
    if (this.open) this.subscribe(channelId);
    let done = false;
    return {
      already: existing !== undefined,
      unwatch: () => {
        if (done) return;
        done = true;
        const entry = this.watched.get(channelId);
        if (!entry) return;
        entry.watchers -= 1;
        if (entry.watchers <= 0) {
          this.watched.delete(channelId);
          if (this.subscribed.delete(channelId) && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'unsubscribe', channelId }));
          }
        }
      },
    };
  }

  private subscribe(channelId: string): void {
    const entry = this.watched.get(channelId);
    if (!entry || this.subscribed.has(channelId) || this.ws?.readyState !== WebSocket.OPEN) return;
    this.subscribed.add(channelId);
    this.lastSubscribe = channelId;
    this.ws.send(
      JSON.stringify({
        type: 'subscribe',
        channelId,
        ...(entry.last !== '0' && { lastSeenId: entry.last }),
      }),
    );
  }

  /** Closes the socket now and for good (until something acquires it again). */
  shutdown(): void {
    this.stop();
  }

  private stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.closeTimer);
    const ws = this.ws;
    this.ws = undefined;
    this.open = false;
    this.subscribed.clear();
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close();
    }
  }

  private fatal(channelId: string | undefined, code: string, message: string, status: number) {
    for (const listener of [...this.listeners]) {
      if (channelId === undefined || listener.channelId === channelId) {
        listener.onFatal(code, message, status);
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, { headers: { authorization: `Bot ${this.token}` } });
    this.ws = ws;
    const dropped = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.open = false;
      this.subscribed.clear();
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.terminate();
      if (this.stopped) return;
      this.reconnects += 1;
      const delay = Math.min(this.backoffBaseMs * 2 ** Math.min(this.failures, 4), 5000);
      this.timer = setTimeout(() => this.connect(), delay);
      this.timer.unref();
    };
    ws.on('open', () => {
      this.open = true;
      this.failures = 0;
      this.opened += 1;
      for (const channelId of this.watched.keys()) this.subscribe(channelId);
      // After a reconnect, also ask over REST: a channel with no newest id has no backfill.
      if (this.opened > 1) for (const listener of [...this.listeners]) listener.onGap();
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      this.failures += 1;
      if (status === 401 || status === 403) {
        this.fatal(
          undefined,
          status === 401 ? 'invalid_token' : 'forbidden',
          'The gateway refused the bot token.',
          status,
        );
      }
      dropped();
    });
    ws.on('error', () => {
      if (!this.open) this.failures += 1;
      dropped();
    });
    ws.on('close', dropped);
    ws.on('message', (data) => this.onFrame(ws, data as Buffer));
  }

  private note(channelId: string, message: Message): void {
    const entry = this.watched.get(channelId);
    if (entry && greater(message.id, entry.last)) entry.last = message.id;
  }

  private onFrame(ws: WebSocket, data: Buffer): void {
    let frame: {
      type?: string;
      code?: string;
      message?: unknown;
      messages?: unknown;
      channelId?: string;
      hasMore?: boolean;
      interaction?: InteractionPayload;
    };
    try {
      frame = JSON.parse(data.toString('utf8')) as typeof frame;
    } catch {
      return;
    }
    if (frame.type === 'interaction.create' && frame.interaction) {
      this.onInteraction(ws, frame.interaction);
      return;
    }
    if (frame.type === 'error') {
      const code = frame.code ?? 'error';
      if (code === 'rate_limited') return;
      const text = typeof frame.message === 'string' ? frame.message : code;
      const channelId = this.lastSubscribe;
      if (channelId) {
        // The frame names no channel; it answers the subscribe sent last.
        this.watched.delete(channelId);
        this.subscribed.delete(channelId);
      }
      this.fatal(
        channelId,
        code,
        text,
        code === 'forbidden' || code === 'missing_scope' ? 403 : 400,
      );
      return;
    }
    if (frame.type === 'backfill' && frame.channelId) {
      const parsed = z.array(Message).safeParse(frame.messages);
      for (const message of parsed.success ? parsed.data : [])
        this.deliver(frame.channelId, message);
      if (frame.hasMore) {
        for (const listener of [...this.listeners]) {
          if (listener.channelId === frame.channelId) listener.onGap();
        }
      }
      return;
    }
    if (frame.type === 'message.created') {
      const parsed = Message.safeParse(frame.message);
      if (parsed.success) this.deliver(parsed.data.channelId, parsed.data);
    }
  }

  private deliver(channelId: string, message: Message): void {
    this.note(channelId, message);
    for (const listener of [...this.listeners]) {
      if (listener.channelId === channelId) listener.onMessage(message);
    }
  }
}
