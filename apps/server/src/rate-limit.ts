import type { Redis } from 'ioredis';

/**
 * Fixed-window counter: INCR plus EXPIRE NX in one transaction, so the window starts at the
 * first hit and a crash between the two commands cannot leave a key without a TTL.
 */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    private readonly max: number,
    private readonly windowSeconds: number,
  ) {}

  async consume(userId: string): Promise<boolean> {
    return (await this.hit(userId)).allowed;
  }

  /** Like `consume`, and also reports how long until the window resets. */
  async hit(subject: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const key = `harmony:ratelimit:${this.name}:${subject}`;
    const results = await this.redis
      .multi()
      .incr(key)
      .expire(key, this.windowSeconds, 'NX')
      .ttl(key)
      .exec();
    const count = Number(results?.[0]?.[1]);
    const ttl = Number(results?.[2]?.[1]);
    return { allowed: count <= this.max, retryAfterSeconds: ttl > 0 ? ttl : this.windowSeconds };
  }
}
