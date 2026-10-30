import type { PanelView } from '@harmony/shared';
import { HarmonyError, type HarmonyClient } from './client.js';

type PanelApi = Pick<HarmonyClient, 'putPanel' | 'deletePanel'>;

export interface PanelSyncOptions {
  /** At most one write per panel in this many milliseconds; later changes are coalesced. */
  minIntervalMs: number;
  /** Space between any two writes of this process, so many panels cannot trip the bot's limit. */
  gapMs: number;
  /** When a channel is full (`panel_limit`): the key of one panel that may go, if any. */
  pickVictim?: (channelId: string) => string | undefined;
  /** Told after a panel was deleted to make room, so the owner forgets what it showed. */
  onEvicted?: (key: string) => void;
  now?: () => number;
  /** Told about write failures that nobody awaits. */
  onError?: (message: string) => void;
}

interface Entry {
  channelId: string;
  key: string;
  render: () => PanelView;
  lastPutAt: number;
  timer: NodeJS.Timeout | undefined;
  inflight: Promise<void> | undefined;
  dirty: boolean;
  removed: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Panels written on behalf of agents. A change only marks a panel dirty; the write renders the
 * newest state, so a burst of tool calls costs one PUT per panel per interval and the panel never
 * shows an older state than one already written.
 */
export class PanelSync {
  private readonly entries = new Map<string, Entry>();
  private tail: Promise<void> = Promise.resolve();
  private lastGlobalAt = 0;
  private closed = false;
  /** PUTs sent so far (tests and diagnostics). */
  puts = 0;

  constructor(
    private readonly api: PanelApi,
    private readonly options: PanelSyncOptions,
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(channelId: string, key: string, render: () => PanelView): void {
    if (this.closed) return;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        channelId,
        key,
        render,
        lastPutAt: 0,
        timer: undefined,
        inflight: undefined,
        dirty: false,
        removed: false,
      };
      this.entries.set(key, entry);
    }
    entry.render = render;
    entry.dirty = true;
    this.schedule(entry);
  }

  private schedule(entry: Entry): void {
    if (entry.timer || entry.inflight || entry.removed || this.closed) return;
    const wait = Math.max(0, entry.lastPutAt + this.options.minIntervalMs - this.now());
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.start(entry);
    }, wait);
  }

  private start(entry: Entry): void {
    entry.inflight = this.enqueue(() => this.put(entry))
      .catch((error: unknown) => {
        this.options.onError?.(
          `panel ${entry.key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        entry.inflight = undefined;
        if (entry.dirty) this.schedule(entry);
      });
  }

  /** Runs `job` after the previous one and at least `gapMs` after the previous one started. */
  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.tail.then(async () => {
      const wait = this.lastGlobalAt + this.options.gapMs - this.now();
      if (wait > 0) await sleep(wait);
      this.lastGlobalAt = this.now();
      await job();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async put(entry: Entry): Promise<void> {
    if (entry.removed) return;
    entry.dirty = false;
    entry.lastPutAt = this.now();
    const view = entry.render();
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.puts += 1;
        await this.api.putPanel(entry.channelId, entry.key, view);
        return;
      } catch (error) {
        if (!(error instanceof HarmonyError) || attempt >= 2) throw error;
        if (error.code === 'panel_limit' && this.options.pickVictim) {
          const victim = this.options.pickVictim(entry.channelId);
          if (!victim) throw error;
          await this.evict(entry.channelId, victim);
          if (entry.removed) return;
        } else if (error.status === 429) {
          await sleep(Math.min(5000, (error.retryAfterSeconds ?? 1) * 1000));
        } else {
          throw error;
        }
      }
    }
  }

  /** Deletes a panel from inside a running write (no queueing: the caller holds the queue). */
  private async evict(channelId: string, key: string): Promise<void> {
    const victim = this.entries.get(key);
    if (victim) {
      victim.removed = true;
      clearTimeout(victim.timer);
      victim.timer = undefined;
      this.entries.delete(key);
    }
    try {
      await this.api.deletePanel(channelId, key);
    } catch (error) {
      if (!(error instanceof HarmonyError && error.status === 404)) throw error;
    }
    this.options.onEvicted?.(key);
  }

  /** Deletes the panel (after any write in flight) and forgets it. */
  async remove(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.removed = true;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    await entry.inflight;
    this.entries.delete(key);
    try {
      await this.enqueue(() => this.api.deletePanel(entry.channelId, key));
    } catch (error) {
      if (!(error instanceof HarmonyError && error.status === 404)) {
        this.options.onError?.(`panel ${key}: could not delete it`);
      }
    }
  }

  /** Writes every panel that has an unwritten change now, ignoring the interval. */
  async flush(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.removed) continue;
      await entry.inflight;
      if (!entry.dirty) continue;
      clearTimeout(entry.timer);
      entry.timer = undefined;
      pending.push(
        this.enqueue(() => this.put(entry)).catch((error: unknown) => {
          this.options.onError?.(
            `panel ${entry.key}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      );
    }
    await Promise.all(pending);
  }

  /** Stops timers; call `flush` first to keep the last states. */
  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
  }
}
