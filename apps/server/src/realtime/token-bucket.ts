/** In-process token bucket: `capacity` frames in a burst, refilled continuously. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(): boolean {
    const current = this.now();
    const elapsedSeconds = (current - this.last) / 1000;
    this.last = current;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
