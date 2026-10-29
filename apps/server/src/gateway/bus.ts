import type { Redis } from 'ioredis';
import { gatewayTopic, type GatewayFrame } from '@harmony/shared';

/** Unacknowledged events are published again after this long (the worker's default). */
export const GATEWAY_ACK_TIMEOUT_MS = 30_000;

const BOTS_SET = 'harmony:gateway:bots';
const botKey = (botId: string) => `harmony:gateway:bot:${botId}`;
export const replyTopic = (instanceId: string) => `harmony:gateway:reply:${instanceId}`;
export const pendingKey = (interactionId: string) => `harmony:gateway:pending:${interactionId}`;

export interface GatewayLimits {
  /** A connection that stops refreshing its entry disappears after this long. */
  ttlMs: number;
  /** Concurrent gateway connections per bot, across all instances. */
  maxConnections: number;
}

/**
 * Which bots are connected to the gateway, on which connection, and the way to reach one.
 * Presence lives in Redis (a sorted set per bot: member `<connectedAt>:<connectionId>`, score =
 * expiry) so every instance and the worker agree; frames travel on a per-connection topic, never
 * straight to a socket.
 */
export class GatewayBus {
  constructor(
    private readonly redis: Redis,
    private readonly limits: GatewayLimits,
  ) {}

  /** Registers a connection. Returns its member id, or null when the bot is at its limit. */
  async connect(botId: string, connectionId: string): Promise<string | null> {
    const key = botKey(botId);
    const now = Date.now();
    const member = `${now}:${connectionId}`;
    const results = await this.redis
      .multi()
      .zremrangebyscore(key, '-inf', String(now))
      .zadd(key, now + this.limits.ttlMs, member)
      .zcard(key)
      .exec();
    if (Number(results?.[2]?.[1]) > this.limits.maxConnections) {
      await this.redis.zrem(key, member);
      return null;
    }
    await this.redis
      .multi()
      .sadd(BOTS_SET, botId)
      .pexpire(key, this.limits.ttlMs * 2)
      .exec();
    return member;
  }

  async touch(botId: string, member: string): Promise<void> {
    const key = botKey(botId);
    await this.redis
      .multi()
      .zadd(key, Date.now() + this.limits.ttlMs, member)
      .pexpire(key, this.limits.ttlMs * 2)
      .exec();
  }

  async disconnect(botId: string, member: string): Promise<void> {
    await this.redis.zrem(botKey(botId), member);
  }

  /** The newest live connection of a bot, or null when it has none anywhere. */
  async pick(botId: string): Promise<string | null> {
    const key = botKey(botId);
    const results = await this.redis
      .multi()
      .zremrangebyscore(key, '-inf', String(Date.now()))
      .zrange(key, '0', '-1')
      .exec();
    const members = (results?.[1]?.[1] ?? []) as string[];
    let newest: { at: number; id: string } | null = null;
    for (const member of members) {
      const split = member.indexOf(':');
      const at = Number(member.slice(0, split));
      if (!newest || at > newest.at) newest = { at, id: member.slice(split + 1) };
    }
    return newest?.id ?? null;
  }

  /** Bots with at least one live connection; prunes the index as it goes. */
  async onlineBots(): Promise<string[]> {
    const ids = await this.redis.smembers(BOTS_SET);
    if (ids.length === 0) return [];
    const now = Date.now();
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.zremrangebyscore(botKey(id), '-inf', String(now));
      pipeline.zcard(botKey(id));
    }
    const results = (await pipeline.exec()) ?? [];
    const online: string[] = [];
    const gone: string[] = [];
    ids.forEach((id, index) => {
      (Number(results[index * 2 + 1]?.[1]) > 0 ? online : gone).push(id);
    });
    if (gone.length > 0) await this.redis.srem(BOTS_SET, ...gone);
    return online;
  }

  /** Publishes a frame to one connection; resolves to how many subscribers got it (0 = gone). */
  async publish(connectionId: string, frame: GatewayFrame): Promise<number> {
    return Number(await this.redis.publish(gatewayTopic(connectionId), JSON.stringify(frame)));
  }
}
