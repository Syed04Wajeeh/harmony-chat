import type { Panel } from '@harmony/shared';

export interface CoalescerOptions {
  /** Window in milliseconds; 0 publishes every push at once. */
  windowMs: number;
  publish(panel: Panel): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Window {
  /** The newest panel pushed since the last publish, if any. */
  pending: Panel | null;
  timer: unknown;
}

/**
 * Limits how often one panel is published: the first change goes out at once (leading edge), and
 * further changes inside the window are held and sent as a single trailing publish that carries
 * the newest version. A bot streaming updates therefore costs one frame per window per panel, not
 * one per write. Modeled on the presence batcher; state is per process, so with several
 * instances each may publish once per window, which clients absorb by ignoring older versions.
 */
export class PanelCoalescer {
  private readonly windows = new Map<string, Window>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: CoalescerOptions) {
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  push(panel: Panel): void {
    if (this.options.windowMs <= 0) {
      this.options.publish(panel);
      return;
    }
    const open = this.windows.get(panel.id);
    if (!open) {
      this.options.publish(panel);
      this.windows.set(panel.id, { pending: null, timer: this.arm(panel.id) });
      return;
    }
    if (!open.pending || panel.version >= open.pending.version) open.pending = panel;
  }

  /** Forgets a panel, for example because it was deleted: no trailing publish follows. */
  cancel(panelId: string): void {
    const open = this.windows.get(panelId);
    if (!open) return;
    this.clearTimer(open.timer);
    this.windows.delete(panelId);
  }

  get pendingCount(): number {
    let count = 0;
    for (const open of this.windows.values()) if (open.pending) count++;
    return count;
  }

  stop(): void {
    for (const open of this.windows.values()) this.clearTimer(open.timer);
    this.windows.clear();
  }

  private arm(panelId: string): unknown {
    return this.setTimer(() => this.fire(panelId), this.options.windowMs);
  }

  private fire(panelId: string): void {
    const open = this.windows.get(panelId);
    if (!open) return;
    if (!open.pending) {
      this.windows.delete(panelId);
      return;
    }
    const panel = open.pending;
    open.pending = null;
    open.timer = this.arm(panelId);
    this.options.publish(panel);
  }
}
