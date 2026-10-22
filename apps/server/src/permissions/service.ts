import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import {
  CORE_PERMISSIONS,
  CORE_PERMISSION_KEYS,
  expand,
  hasPermission,
  type EffectivePermissions,
  type PermissionDefinition,
  type Permissions,
} from '@harmony/shared';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import {
  loadGuildAccess,
  permissionsIn,
  rankOf,
  type GuildAccess,
  type Subject,
} from './access.js';

/** Carries a guild id; every instance drops its cached permissions for that guild. */
export const PERMISSIONS_INVALIDATE_TOPIC = 'harmony:permissions:invalidate';

/** Safety net for a missed invalidation message (a Redis blip). */
const TTL_MS = 5 * 60_000;
const MAX_GUILDS = 2000;
const MAX_CHANNELS = 20_000;

interface Entry {
  loadedAt: number;
  access: Promise<GuildAccess | null>;
}

/**
 * Per-guild roles, member roles and channel overwrites, cached in process like the guild module
 * state: a check costs a map lookup and a few set operations and never touches the database
 * once the guild is warm. Writers commit, then call `changed`, which drops the guild here and
 * on every other instance over Redis.
 */
export class PermissionService {
  private readonly cache = new Map<string, Entry>();
  private readonly guildOfChannel = new Map<string, string | null>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    /** Permissions modules define, by module id. Filled in as modules register. */
    private readonly moduleKeys: ReadonlyMap<string, readonly PermissionDefinition[]>,
  ) {}

  /** Every key a role may hold: the core keys and the ones enabled modules define. */
  isKnownKey(key: string): boolean {
    if (CORE_PERMISSION_KEYS.has(key)) return true;
    for (const definitions of this.moduleKeys.values()) {
      if (definitions.some((definition) => definition.key === key)) return true;
    }
    return false;
  }

  allKeys(): string[] {
    return [
      ...CORE_PERMISSIONS.map((permission) => permission.key),
      ...[...this.moduleKeys.values()].flatMap((list) => list.map((p) => p.key)),
    ];
  }

  invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }

  /** Call after committing a change that affects permissions or membership of the guild. */
  async changed(guildId: string): Promise<void> {
    this.invalidate(guildId);
    await this.redis.publish(PERMISSIONS_INVALIDATE_TOPIC, guildId).catch(() => undefined);
  }

  /** The guild's access data; null when it does not exist. */
  access(guildId: string): Promise<GuildAccess | null> {
    const cached = this.cache.get(guildId);
    if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.access;

    if (this.cache.size >= MAX_GUILDS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const entry: Entry = { loadedAt: Date.now(), access: loadGuildAccess(this.db, guildId) };
    this.cache.set(guildId, entry);
    // A failed load must not be remembered.
    entry.access.catch(() => {
      if (this.cache.get(guildId) === entry) this.cache.delete(guildId);
    });
    return entry.access;
  }

  async requireAccess(guildId: string): Promise<GuildAccess> {
    const access = await this.access(guildId);
    if (!access) throw new AppError(404, 'guild_not_found', 'Guild not found');
    return access;
  }

  /**
   * The subject's permissions, or null when they are not in the guild. Instance admins are
   * resolved even if they are not members: the override predates roles and stays.
   */
  async resolve(
    subject: Subject,
    guildId: string,
    channelId?: string,
  ): Promise<Permissions | null> {
    const access = await this.requireAccess(guildId);
    if (!access.members.has(subject.id) && !subject.isAdmin) return null;
    return permissionsIn(access, subject, channelId);
  }

  async has(subject: Subject, guildId: string, key: string, channelId?: string): Promise<boolean> {
    const permissions = await this.resolve(subject, guildId, channelId);
    return permissions !== null && hasPermission(permissions, key);
  }

  /** 403 `forbidden` for non-members, 403 `missing_permission` for members without the key. */
  async require(subject: Subject, guildId: string, key: string, channelId?: string): Promise<void> {
    const permissions = await this.resolve(subject, guildId, channelId);
    if (!permissions) throw new AppError(403, 'forbidden', 'You are not a member of this guild');
    if (!hasPermission(permissions, key)) throw missing(key);
  }

  /** Like `require`, for a channel id; a DM has no guild and no permissions to check. */
  async requireInChannel(subject: Subject, channelId: string, key: string): Promise<void> {
    const guildId = await this.guildOf(channelId);
    if (guildId) await this.require(subject, guildId, key, channelId);
  }

  /** The guild a channel belongs to (null for DMs, undefined for unknown ids). Never changes. */
  async guildOf(channelId: string): Promise<string | null | undefined> {
    const cached = this.guildOfChannel.get(channelId);
    if (cached !== undefined) return cached;
    const row = await this.db
      .selectFrom('channels')
      .select('guild_id')
      .where('id', '=', channelId)
      .executeTakeFirst();
    if (!row) return undefined;
    if (this.guildOfChannel.size >= MAX_CHANNELS) this.guildOfChannel.clear();
    this.guildOfChannel.set(channelId, row.guild_id);
    return row.guild_id;
  }

  async effective(
    subject: Subject,
    guildId: string,
    channelId?: string,
  ): Promise<EffectivePermissions> {
    const access = await this.requireAccess(guildId);
    const permissions = await this.resolve(subject, guildId, channelId);
    if (!permissions) throw new AppError(403, 'forbidden', 'You are not a member of this guild');
    return {
      permissions: expand(permissions, this.allKeys()),
      administrator: permissions.all,
      isOwner: access.ownerId === subject.id,
      topPosition: rankOf(access, subject).top,
    };
  }
}

export const missing = (key: string) =>
  new AppError(403, 'missing_permission', `You need the ${key} permission to do that`);
