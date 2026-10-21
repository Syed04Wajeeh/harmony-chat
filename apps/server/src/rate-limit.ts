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
    const key = `harmony:ratelimit:${this.name}:${userId}`;
    const results = await this.redis.multi().incr(key).expire(key, this.windowSeconds, 'NX').exec();
    const count = Number(results?.[0]?.[1]);
    return count <= this.max;
  }
}
