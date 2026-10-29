import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import type { PresenceEntry, PresenceStatus, UserStatus } from '@harmony/shared';
import type { Database } from '../db/schema.js';
import type { GuildAccess } from '../permissions/access.js';
import type { EventBus } from '../realtime/events.js';
import { effectiveStatus, presenceTopicsOf, type Memberships } from './scope.js';

const ONLINE_SET = 'harmony:presence:online';
/** User id to the status shown to others (online, idle or dnd). Absent means offline or invisible. */
const STATUS_HASH = 'harmony:presence:status';
/** User id to the status the user chose (online, idle, dnd, or offline for invisible). */
const CHOSEN_HASH = 'harmony:presence:chosen';
const connectionsKey = (userId: string): string => `harmony:presence:${userId}`;
const idleKey = (userId: string): string => `harmony:presence:idle:${userId}`;
/** HMGET size per round trip. */
const STATUS_CHUNK = 2000;

/**
 * One atomic step that both updates a user's live-connection ZSET and says whether the user
 * flipped between online and offline. The ONLINE set is the source of truth for "marked online",
 * so transitions are reported exactly once however many instances and sweepers race. The shown
 * status lives in the STATUS hash and changes in the same step, so a snapshot never sees a user
 * who is offline with a status, or online without one (apart from the instant between a
 * heartbeat re-registering a swept user and `status` being applied).
 *
 * The shown status is derived: the CHOSEN hash holds what the user picked (online, idle, dnd or
 * offline for invisible); only a chosen 'online' is refined by automatic idleness, which is per
 * connection. The IDLE hash (per user, connection id to 1) lists the connections that reported
 * themselves idle; the user shows as idle when every live connection is in it. Entries of
 * connections that expired are dropped whenever the shown status is recomputed.
 *
 * KEYS: connections ZSET, ONLINE set, STATUS hash, CHOSEN hash, IDLE hash.
 * ARGV: op (touch | remove | sweep | status | activity), connection id, user id, connection ttl
 * ms, chosen status ('' = unknown, 'offline' = hidden), idle flag ('1' or '0', activity only).
 * Returns 1 when the user just came online, -1 when just went offline, 2 when the shown status
 * changed without that, 0 otherwise. For `status`: the new shown status, or '' if the user is
 * not online. For `activity`: the new shown status if it changed, else ''.
 * The clock is Redis's own (TIME), so instances with skewed clocks agree on expiry.
 */
const PRESENCE_SCRIPT = `
local op, member, userId, ttl, chosen, idleFlag = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4]), ARGV[5], ARGV[6]
local function derive()
  local c = redis.call('HGET', KEYS[4], userId)
  if c ~= 'online' then return c end
  local total = redis.call('ZCARD', KEYS[1])
  if total == 0 then return c end
  local idle = 0
  for _, id in ipairs(redis.call('HKEYS', KEYS[5])) do
    if redis.call('ZSCORE', KEYS[1], id) then idle = idle + 1 else redis.call('HDEL', KEYS[5], id) end
  end
  if idle >= total then return 'idle' end
  return 'online'
end
local function show()
  local shown = derive()
  if shown == 'offline' or not shown then redis.call('HDEL', KEYS[3], userId)
  else redis.call('HSET', KEYS[3], userId, shown) end
  return shown
end
local function refresh()
  local before = redis.call('HGET', KEYS[3], userId)
  local after = derive()
  if after and after ~= 'offline' and after ~= before then redis.call('HSET', KEYS[3], userId, after) return after end
  return ''
end
if op == 'status' then
  if chosen ~= '' then redis.call('HSET', KEYS[4], userId, chosen) end
  if redis.call('SISMEMBER', KEYS[2], userId) == 1 then return show() or '' end
  return ''
end
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if op == 'activity' then
  if not redis.call('ZSCORE', KEYS[1], member) then return '' end
  if idleFlag == '1' then
    redis.call('HSET', KEYS[5], member, 1)
    redis.call('PEXPIRE', KEYS[5], ttl * 2)
  else
    redis.call('HDEL', KEYS[5], member)
  end
  if redis.call('SISMEMBER', KEYS[2], userId) == 0 then return '' end
  return refresh()
end
if op == 'touch' then
  local fresh = redis.call('ZADD', KEYS[1], now + ttl, member)
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
  if redis.call('HLEN', KEYS[5]) > 0 then redis.call('PEXPIRE', KEYS[5], ttl * 2) end
  local added = redis.call('SADD', KEYS[2], userId)
  if added == 1 then
    redis.call('DEL', KEYS[5])
    if chosen ~= '' then redis.call('HSET', KEYS[4], userId, chosen) end
    if chosen ~= '' then show() end
    return 1
  end
  -- A new connection starts active, which can end an automatic idle. The chosen status it
  -- carries comes from the database, so a value cached before a migration cannot outlive it.
  if fresh == 1 and chosen ~= '' then redis.call('HSET', KEYS[4], userId, chosen) end
  if fresh == 1 and refresh() ~= '' then return 2 end
  return 0
end
if op == 'remove' then
  redis.call('ZREM', KEYS[1], member)
  redis.call('HDEL', KEYS[5], member)
end
if redis.call('ZCARD', KEYS[1]) == 0 and redis.call('SREM', KEYS[2], userId) == 1 then
  redis.call('HDEL', KEYS[3], userId)
  redis.call('DEL', KEYS[5])
  return -1
end
if redis.call('SISMEMBER', KEYS[2], userId) == 1 and refresh() ~= '' then return 2 end
return 0
`;

export interface PresenceOptions {
  ttlMs: number;
  sweepMs: number;
}

export interface PresenceLogger {
  warn(obj: object, msg: string): void;
}

/** Where a guild's members come from; the permission cache, so no query per call once warm. */
export interface GuildMembers {
  access(guildId: string): Promise<GuildAccess | null>;
}

/** Topics of a user's sockets on this instance, or null when it has none. */
export type LocalTopics = (userId: string) => string[] | null;

/**
 * Who is online and what they show, scoped: a user's presence is published to the topics of the
 * guilds and DMs they are in (see scope.ts) and snapshots only list people who share one of them.
 */
export class PresenceService {
  private timer: NodeJS.Timeout | undefined;
  private localTopics: LocalTopics = () => null;

  constructor(
    private readonly redis: Redis,
    private readonly db: Kysely<Database>,
    private readonly events: EventBus,
    private readonly options: PresenceOptions,
    private readonly log: PresenceLogger,
    private readonly guilds?: GuildMembers,
  ) {}

  /** Lets the service reuse the topics a connected user's sockets already know (no query). */
  useLocalTopics(source: LocalTopics): void {
    this.localTopics = source;
  }

  /**
   * Registers a connection, or refreshes its expiry; call again on every heartbeat.
   * `status` is what the user's chosen status shows as; `topics` the user's presence topics.
   * Both are looked up when missing, which only happens when a heartbeat re-registers a user
   * that was swept.
   */
  async touch(
    userId: string,
    connectionId: string,
    known: { status?: UserStatus; topics?: readonly string[] } = {},
  ): Promise<void> {
    const shown = known.status ? effectiveStatus(known.status) : '';
    const result = Number(await this.run('touch', userId, connectionId, shown));
    if (result === 2) return this.publishCurrent(userId, known.topics);
    if (result !== 1) return;
    const status = shown || (await this.applyChosenStatus(userId));
    await this.publish(userId, status, known.topics);
  }

  /** `topics` must be captured before the socket leaves the hub, which is why it is a parameter. */
  async disconnect(
    userId: string,
    connectionId: string,
    topics?: readonly string[],
  ): Promise<void> {
    const result = Number(await this.run('remove', userId, connectionId));
    if (result === -1) await this.publish(userId, 'offline', topics);
    else if (result === 2) await this.publishCurrent(userId, topics);
  }

  /** Expires stale connections of every online user, whichever instance owned them. */
  async sweep(): Promise<void> {
    for (const userId of await this.redis.smembers(ONLINE_SET)) {
      const result = Number(await this.run('sweep', userId, ''));
      if (result === -1) await this.publish(userId, 'offline');
      else if (result === 2) await this.publishCurrent(userId);
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

  /** Call after a user changes their chosen status. */
  async statusChanged(userId: string, status: UserStatus): Promise<void> {
    const shown = effectiveStatus(status);
    const now = String(await this.run('status', userId, '', shown));
    if (now) await this.publish(userId, now as PresenceStatus);
  }

  /**
   * One connection says whether it is idle (no interaction for a while, or hidden). The user
   * shows as idle only when their chosen status is online and every connection is idle, so
   * activity on any device brings them back. Publishes only when the shown status changes.
   */
  async activity(userId: string, connectionId: string, idle: boolean): Promise<void> {
    const now = String(await this.run('activity', userId, connectionId, '', idle ? '1' : '0'));
    if (now) await this.publish(userId, now as PresenceStatus);
  }

  /** The guilds and DMs of a user, from the database. Used once per connection. */
  async memberships(userId: string): Promise<Memberships> {
    const { rows } = await sql<{ kind: string; id: string; peer: string | null }>`
      select 'g' as kind, guild_id::text as id, null::text as peer
        from guild_members where user_id = ${userId}
      union all
      select 'd', c.id::text, other.user_id::text
        from channel_members mine
        join channels c on c.id = mine.channel_id and c.kind = 'dm'
        join channel_members other on other.channel_id = c.id and other.user_id <> mine.user_id
        where mine.user_id = ${userId}
    `.execute(this.db);
    return {
      guildIds: rows.filter((r) => r.kind === 'g').map((r) => r.id),
      dms: rows.flatMap((r) =>
        r.kind === 'd' && r.peer ? [{ channelId: r.id, peerId: r.peer }] : [],
      ),
    };
  }

  async topicsOf(userId: string): Promise<string[]> {
    return presenceTopicsOf(await this.memberships(userId));
  }

  /**
   * Online, idle and dnd users among `userIds`; invisible users are left out like offline ones.
   * One hash read per 2,000 ids, no database.
   */
  async statusesOf(userIds: readonly string[]): Promise<PresenceEntry[]> {
    const entries: PresenceEntry[] = [];
    for (let i = 0; i < userIds.length; i += STATUS_CHUNK) {
      const chunk = userIds.slice(i, i + STATUS_CHUNK);
      const values = await this.redis.hmget(STATUS_HASH, ...chunk);
      values.forEach((status, index) => {
        const userId = chunk[index];
        if (userId !== undefined && status && status !== 'offline') {
          entries.push({ userId, status: status as PresenceStatus });
        }
      });
    }
    return entries;
  }

  /**
   * The presence of everyone who shares a guild or a DM with the viewer (and the viewer). The
   * guild members come from the permission cache, the statuses from one Redis hash.
   */
  async snapshotFor(viewerId: string): Promise<PresenceEntry[]> {
    const { guildIds, dms } = await this.memberships(viewerId);
    const visible = new Set<string>([viewerId, ...dms.map((dm) => dm.peerId)]);
    if (this.guilds) {
      const guilds = this.guilds;
      const accesses = await Promise.all(guildIds.map((id) => guilds.access(id)));
      for (const access of accesses) {
        if (access) for (const memberId of access.members.keys()) visible.add(memberId);
      }
    }
    return this.statusesOf([...visible]);
  }

  /** Tells the topics a user just joined how they are doing (nothing if offline or invisible). */
  async announceTo(userId: string, topics: readonly string[]): Promise<void> {
    if (topics.length === 0) return;
    const shown = await this.redis.hget(STATUS_HASH, userId);
    if (shown && shown !== 'offline') await this.publish(userId, shown as PresenceStatus, topics);
  }

  private async run(
    op: string,
    userId: string,
    connectionId: string,
    chosen = '',
    idle = '0',
  ): Promise<unknown> {
    return this.redis.eval(
      PRESENCE_SCRIPT,
      5,
      connectionsKey(userId),
      ONLINE_SET,
      STATUS_HASH,
      CHOSEN_HASH,
      idleKey(userId),
      op,
      connectionId,
      userId,
      this.options.ttlMs,
      chosen,
      idle,
    );
  }

  /** Publishes whatever the user currently shows (after a transition that did not say). */
  private async publishCurrent(userId: string, topics?: readonly string[]): Promise<void> {
    const shown = await this.redis.hget(STATUS_HASH, userId);
    if (shown) await this.publish(userId, shown as PresenceStatus, topics);
  }

  /** Reads the chosen status from the database and applies it; used when it was not known. */
  private async applyChosenStatus(userId: string): Promise<PresenceStatus> {
    const row = await this.db
      .selectFrom('users')
      .select('status')
      .where('id', '=', userId)
      .executeTakeFirst();
    const shown = row ? effectiveStatus(row.status) : 'offline';
    return (String(await this.run('status', userId, '', shown)) || shown) as PresenceStatus;
  }

  /**
   * Publishes to the user's topics: given, else those of the user's sockets on this instance,
   * else from the database (a status changed through REST on another instance, or a user swept
   * after their instance died).
   */
  private async publish(
    userId: string,
    status: PresenceStatus,
    topics?: readonly string[],
  ): Promise<void> {
    const targets = topics ?? this.localTopics(userId) ?? (await this.topicsOf(userId));
    if (targets.length === 0) return;
    await this.events.toPresenceTopics(targets, { type: 'presence.updated', userId, status });
  }
}
