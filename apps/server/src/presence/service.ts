import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { PresenceEntry, PresenceStatus, UserStatus } from '@harmony/shared';
import type { Database } from '../db/schema.js';
import type { EventBus } from '../realtime/events.js';

const ONLINE_SET = 'harmony:presence:online';
const connectionsKey = (userId: string): string => `harmony:presence:${userId}`;

/**
 * One atomic step that both updates a user's live-connection ZSET and says whether the user
 * flipped between online and offline. The ONLINE set is the source of truth for "marked online",
 * so transitions are reported exactly once however many instances and sweepers race.
 *
 * ARGV: op (touch | remove | sweep), connection id, user id, connection ttl ms.
 * Returns 1 when the user just came online, -1 when just went offline, 0 otherwise.
 * The clock is Redis's own (TIME), so instances with skewed clocks agree on expiry.
 */
const PRESENCE_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local op, member, userId, ttl = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if op == 'touch' then
  redis.call('ZADD', KEYS[1], now + ttl, member)
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
  return redis.call('SADD', KEYS[2], userId)
end
if op == 'remove' then
  redis.call('ZREM', KEYS[1], member)
end
if redis.call('ZCARD', KEYS[1]) == 0 and redis.call('SREM', KEYS[2], userId) == 1 then
  return -1
end
return 0
`;

export interface PresenceOptions {
  ttlMs: number;
  sweepMs: number;
}

export interface PresenceLogger {
  warn(obj: object, msg: string): void;
}

export class PresenceService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly redis: Redis,
    private readonly db: Kysely<Database>,
    private readonly events: EventBus,
    private readonly options: PresenceOptions,
    private readonly log: PresenceLogger,
  ) {}

  /** Registers a connection, or refreshes its expiry; call again on every heartbeat. */
  async touch(userId: string, connectionId: string): Promise<void> {
    if ((await this.run('touch', userId, connectionId)) === 1) await this.announce(userId, true);
  }

  async disconnect(userId: string, connectionId: string): Promise<void> {
    if ((await this.run('remove', userId, connectionId)) === -1) await this.announce(userId, false);
  }

  /** Expires stale connections of every online user, whichever instance owned them. */
  async sweep(): Promise<void> {
    for (const userId of await this.redis.smembers(ONLINE_SET)) {
      if ((await this.run('sweep', userId, '')) === -1) await this.announce(userId, false);
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((err: unknown) => this.log.warn({ err }, 'presence sweep failed'));
    }, this.options.sweepMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Online, idle and dnd users; invisible users are left out like offline ones. */
  async snapshot(): Promise<PresenceEntry[]> {
    const ids = await this.redis.smembers(ONLINE_SET);
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom('users')
      .select(['id', 'status'])
      .where('id', 'in', ids)
      .execute();
    return rows
      .filter((row) => row.status !== 'invisible')
      .map((row) => ({ userId: row.id, status: row.status as PresenceStatus }));
  }

  /** Call after a user changes their chosen status. */
  async statusChanged(userId: string, status: UserStatus): Promise<void> {
    if (await this.redis.sismember(ONLINE_SET, userId)) {
      await this.events.toEveryone({
        type: 'presence.updated',
        userId,
        status: status === 'invisible' ? 'offline' : status,
      });
    }
  }

  private async run(op: string, userId: string, connectionId: string): Promise<number> {
    const result = await this.redis.eval(
      PRESENCE_SCRIPT,
      2,
      connectionsKey(userId),
      ONLINE_SET,
      op,
      connectionId,
      userId,
      this.options.ttlMs,
    );
    return Number(result);
  }

  private async announce(userId: string, online: boolean): Promise<void> {
    let status: PresenceStatus = 'offline';
    if (online) {
      const row = await this.db
        .selectFrom('users')
        .select('status')
        .where('id', '=', userId)
        .executeTakeFirst();
      status = !row || row.status === 'invisible' ? 'offline' : (row.status as PresenceStatus);
    }
    await this.events.toEveryone({ type: 'presence.updated', userId, status });
  }
}
