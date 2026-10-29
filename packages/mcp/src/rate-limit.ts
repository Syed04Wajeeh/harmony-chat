/** Rolling-window limiter, one per process. A looping agent hits it long before Harmony's own limits. */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one use and returns 0, or returns the seconds to wait without recording. */
  take(): number {
    const now = this.now();
    while (this.stamps.length > 0 && now - (this.stamps[0] ?? now) >= this.windowMs) {
      this.stamps.shift();
    }
    if (this.stamps.length >= this.max) {
      const oldest = this.stamps[0] ?? now;
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
    }
    this.stamps.push(now);
    return 0;
  }
}
