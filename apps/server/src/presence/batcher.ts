import type { PresenceEntry, PresenceStatus } from '@harmony/shared';

/** Frames carry at most this many updates, so one burst cannot make a multi-megabyte frame. */
export const MAX_UPDATES_PER_FRAME = 500;
/** Past this many remembered users in one topic the memory of what was sent is dropped. */
const MAX_REMEMBERED = 100_000;

export interface BatcherOptions {
  /** Window in milliseconds; 0 delivers every push at once. */
  windowMs: number;
  /** Called once per topic per window with the updates that changed something. */
  onFlush(topic: string, updates: PresenceEntry[]): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Coalesces presence changes per topic (a guild or a DM) over a short window.
 *
 * Within a window the last write per user wins, and updates come out in the order of those last
 * writes. A user whose final state equals what this topic last sent is left out, so an
 * online -> offline -> online flap inside one window sends nothing if online was already sent.
 * State is per topic, not per socket: its size follows the topic's users, not the number of
 * sockets, which matters for a guild with thousands of connected members.
 */
export class PresenceBatcher {
  private pending = new Map<string, Map<string, PresenceStatus>>();
  private readonly sent = new Map<string, Map<string, PresenceStatus>>();
  private timer: unknown;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: BatcherOptions) {
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  push(topic: string, userId: string, status: PresenceStatus): void {
    let topicPending = this.pending.get(topic);
    if (!topicPending) {
      topicPending = new Map();
      this.pending.set(topic, topicPending);
    }
    // Delete first so the entry moves to the end: output order is the order of the last writes.
    topicPending.delete(userId);
    topicPending.set(userId, status);
    if (this.options.windowMs <= 0) this.flush();
    else if (this.timer === undefined) {
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        this.flush();
      }, this.options.windowMs);
    }
  }

  /** Delivers everything pending now. */
  flush(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    const batch = this.pending;
    this.pending = new Map();
    for (const [topic, entries] of batch) {
      let sent = this.sent.get(topic);
      if (!sent || sent.size > MAX_REMEMBERED) {
        sent = new Map();
        this.sent.set(topic, sent);
      }
      const updates: PresenceEntry[] = [];
      for (const [userId, status] of entries) {
        if (sent.get(userId) === status) continue;
        sent.set(userId, status);
        updates.push({ userId, status });
      }
      for (let i = 0; i < updates.length; i += MAX_UPDATES_PER_FRAME) {
        this.options.onFlush(topic, updates.slice(i, i + MAX_UPDATES_PER_FRAME));
      }
    }
  }

  /**
   * Forget what was sent for a topic. Call when a socket joins it: the newcomer was not told the
   * old state, so a flap must not be suppressed against it.
   */
  forget(topic: string): void {
    this.sent.delete(topic);
  }

  /** Discards a topic's state when its last local socket leaves. */
  drop(topic: string): void {
    this.sent.delete(topic);
    this.pending.delete(topic);
  }

  get pendingTopics(): number {
    return this.pending.size;
  }

  stop(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}
