import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import {
  findCustomEmoji,
  mapCustomEmoji,
  parseCustomEmoji,
  type CustomEmojiToken,
  type GuildEmoji,
} from '@harmony/shared';
import type { Database } from '../db/schema.js';
import type { GuildModuleState } from '../modules/guild-state.js';
import type { PerkService } from '../perks/service.js';

/** Carries a guild id; every instance drops its cached emoji for that guild. */
export const EMOJI_INVALIDATE_TOPIC = 'harmony:emoji:invalidate';
export const EMOJI_MODULE_ID = 'custom-emoji';

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 20_000;

export interface EmojiRef {
  id: string;
  guildId: string;
  name: string;
  animated: boolean;
}

export const canonical = (emoji: EmojiRef): string =>
  `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;

interface Loaded {
  loadedAt: number;
  byId: Map<string, EmojiRef>;
}

/**
 * Custom emoji known to this instance, per guild, so checking a message's tokens costs map
 * lookups and no query once the guild is warm. Messages without tokens never reach it. Writers
 * commit, then call `changed`, which drops the guild here and on every other instance.
 */
export class EmojiService {
  private readonly guilds = new Map<string, Promise<Loaded>>();
  private readonly loadedAt = new Map<string, number>();
  /** Ids looked up on their own (an emoji from another guild); `null` means no such emoji. */
  private readonly strays = new Map<string, EmojiRef | null>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    private readonly state: GuildModuleState,
    private readonly perks: PerkService,
  ) {}

  invalidate(guildId: string): void {
    this.guilds.delete(guildId);
    this.loadedAt.delete(guildId);
    this.strays.clear();
  }

  async changed(guildId: string): Promise<void> {
    this.invalidate(guildId);
    await this.redis.publish(EMOJI_INVALIDATE_TOPIC, guildId).catch(() => undefined);
  }

  private guildMap(guildId: string): Promise<Loaded> {
    const cached = this.guilds.get(guildId);
    if (cached && Date.now() - (this.loadedAt.get(guildId) ?? 0) < TTL_MS) return cached;
    if (this.guilds.size >= MAX_ENTRIES) this.guilds.clear();
    const loading = this.db
      .selectFrom('guild_emoji')
      .select(['id', 'guild_id', 'name', 'animated'])
      .where('guild_id', '=', guildId)
      .execute()
      .then((rows) => ({
        loadedAt: Date.now(),
        byId: new Map(
          rows.map((row) => [
            row.id,
            { id: row.id, guildId: row.guild_id, name: row.name, animated: row.animated },
          ]),
        ),
      }));
    this.guilds.set(guildId, loading);
    this.loadedAt.set(guildId, Date.now());
    loading.catch(() => this.invalidate(guildId));
    return loading;
  }

  private async lookup(id: string, guildId: string | null): Promise<EmojiRef | null> {
    if (guildId) {
      const own = (await this.guildMap(guildId)).byId.get(id);
      if (own) return own;
    }
    if (this.strays.has(id)) return this.strays.get(id) ?? null;
    const row = await this.db
      .selectFrom('guild_emoji')
      .select(['id', 'guild_id', 'name', 'animated'])
      .where('id', '=', id)
      .executeTakeFirst();
    const found = row
      ? { id: row.id, guildId: row.guild_id, name: row.name, animated: row.animated }
      : null;
    if (this.strays.size >= MAX_ENTRIES) this.strays.clear();
    this.strays.set(id, found);
    return found;
  }

  private async isMember(userId: string, guildId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('guild_members')
      .select('user_id')
      .where('guild_id', '=', guildId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The emoji if `userId` may use it in a message of `guildId`: it belongs to that guild, or
   * the user has the cross-server perk and belongs to the emoji's guild. Null otherwise.
   */
  async usable(userId: string, guildId: string | null, id: string): Promise<EmojiRef | null> {
    const emoji = await this.lookup(id, guildId);
    if (!emoji) return null;
    if (!(await this.state.isEnabled(emoji.guildId, EMOJI_MODULE_ID))) return null;
    if (emoji.guildId === guildId) return emoji;
    if (!(await this.perks.has(userId, 'cross_server_emoji'))) return null;
    return (await this.isMember(userId, emoji.guildId)) ? emoji : null;
  }

  /** Message content with tokens the sender cannot use turned into plain `:name:` text. */
  async sanitize(content: string, userId: string, guildId: string | null): Promise<string> {
    const tokens = findCustomEmoji(content);
    if (tokens.length === 0) return content;
    const resolved = new Map<string, string | null>();
    for (const token of tokens) {
      if (resolved.has(token.id)) continue;
      const emoji = await this.usable(userId, guildId, token.id);
      resolved.set(token.id, emoji ? canonical(emoji) : null);
    }
    return mapCustomEmoji(content, (token: CustomEmojiToken) => resolved.get(token.id) ?? null);
  }

  /** A reaction or status emoji in canonical form, or null when the user cannot use it. */
  async resolveToken(
    userId: string,
    guildId: string | null,
    value: string,
  ): Promise<string | null> {
    const token = parseCustomEmoji(value);
    if (!token) return null;
    const emoji = await this.usable(userId, guildId, token.id);
    return emoji ? canonical(emoji) : null;
  }

  /** A status emoji in canonical form: the user needs the status perk and must be in the emoji's guild. */
  async statusToken(userId: string, value: string): Promise<string | null> {
    const token = parseCustomEmoji(value);
    if (!token || !(await this.perks.has(userId, 'custom_status_emoji'))) return null;
    const emoji = await this.lookup(token.id, null);
    if (!emoji || !(await this.state.isEnabled(emoji.guildId, EMOJI_MODULE_ID))) return null;
    return (await this.isMember(userId, emoji.guildId)) ? canonical(emoji) : null;
  }

  async list(guildId: string): Promise<GuildEmoji[]> {
    const rows = await this.db
      .selectFrom('guild_emoji')
      .innerJoin('attachments', 'attachments.id', 'guild_emoji.attachment_id')
      .leftJoin('users', 'users.id', 'guild_emoji.created_by')
      .select([
        'guild_emoji.id',
        'guild_emoji.guild_id',
        'guild_emoji.name',
        'guild_emoji.animated',
        'guild_emoji.created_by',
        'guild_emoji.created_at',
        'users.display_name as creator',
        'attachments.filename',
      ])
      .where('guild_emoji.guild_id', '=', guildId)
      .orderBy('guild_emoji.name')
      .execute();
    return rows.map(toApi);
  }

  /** Emoji of every guild the user is in, flagged by whether the user could use them elsewhere. */
  async listForUser(userId: string): Promise<(GuildEmoji & { usable: boolean })[]> {
    const rows = await this.db
      .selectFrom('guild_emoji')
      .innerJoin('guild_members', 'guild_members.guild_id', 'guild_emoji.guild_id')
      .innerJoin('attachments', 'attachments.id', 'guild_emoji.attachment_id')
      .leftJoin('users', 'users.id', 'guild_emoji.created_by')
      .select([
        'guild_emoji.id',
        'guild_emoji.guild_id',
        'guild_emoji.name',
        'guild_emoji.animated',
        'guild_emoji.created_by',
        'guild_emoji.created_at',
        'users.display_name as creator',
        'attachments.filename',
      ])
      .where('guild_members.user_id', '=', userId)
      .orderBy('guild_emoji.name')
      .execute();
    const cross = await this.perks.has(userId, 'cross_server_emoji');
    return rows.map((row) => ({ ...toApi(row), usable: cross }));
  }
}

interface Row {
  id: string;
  guild_id: string;
  name: string;
  animated: boolean;
  created_by: string | null;
  created_at: Date;
  creator: string | null;
  filename: string;
}

export function toApi(row: Row): GuildEmoji {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    animated: row.animated,
    url: `/api/emoji/${row.id}/${encodeURIComponent(row.filename)}`,
    createdBy: row.created_by,
    createdByName: row.creator,
    createdAt: row.created_at.toISOString(),
  };
}
