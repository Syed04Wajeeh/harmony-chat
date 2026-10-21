import { sql, type Kysely, type Selectable } from 'kysely';
import {
  UNREAD_COUNT_CAP,
  type Channel,
  type ChannelSummary,
  type CreateChannelBody,
  type DirectoryUser,
  type ReadState,
  type UpdateChannelBody,
  type User,
} from '@harmony/shared';
import { toDirectoryUser } from '../auth/user-store.js';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { EventBus } from '../realtime/events.js';

type ChannelRow = Selectable<Database['channels']>;

interface SummaryRow {
  id: string;
  guild_id: string | null;
  kind: 'text' | 'dm';
  name: string | null;
  topic: string | null;
  is_private: boolean;
  created_by: string | null;
  last_read_message_id: string | null;
  last_message_id: string | null;
  unread_count: number;
  mention_count: number;
}

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: string }).code === UNIQUE_VIOLATION;

const toChannel = (row: ChannelRow, dmUser: User | null = null): Channel => ({
  id: row.id,
  guildId: row.guild_id,
  kind: row.kind as Channel['kind'],
  name: row.name,
  topic: row.topic,
  isPrivate: row.is_private,
  createdBy: row.created_by,
  dmUser,
});

const freshSummary = (row: ChannelRow): ChannelSummary => ({
  ...toChannel(row),
  unreadCount: 0,
  mentionCount: 0,
  lastMessageId: null,
  lastReadMessageId: null,
});

const toUser = ({ id, login, displayName, avatarUrl }: DirectoryUser): User => ({
  id,
  login,
  displayName,
  avatarUrl,
});

type Actor = Pick<DirectoryUser, 'id' | 'isAdmin'>;

export class ChannelService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly events: EventBus,
  ) {}

  /** Loads a channel the actor belongs to: 404 if it does not exist, 403 if they are not a member. */
  async requireMember(channelId: string, userId: string): Promise<ChannelRow> {
    const row = await this.db
      .selectFrom('channels')
      .selectAll('channels')
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('channel_members')
              .select('user_id')
              .whereRef('channel_members.channel_id', '=', 'channels.id')
              .where('channel_members.user_id', '=', userId),
          )
          .as('is_member'),
      )
      .where('channels.id', '=', channelId)
      .executeTakeFirst();
    if (!row) throw new AppError(404, 'channel_not_found', 'Channel not found');
    if (!row.is_member)
      throw new AppError(403, 'forbidden', 'You are not a member of this channel');
    return row;
  }

  async memberIds(channelId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('channel_members')
      .select('user_id')
      .where('channel_id', '=', channelId)
      .execute();
    return rows.map((row) => row.user_id);
  }

  async members(actor: Actor, channelId: string): Promise<DirectoryUser[]> {
    await this.requireMember(channelId, actor.id);
    const rows = await this.db
      .selectFrom('channel_members')
      .innerJoin('users', 'users.id', 'channel_members.user_id')
      .selectAll('users')
      .where('channel_members.channel_id', '=', channelId)
      .orderBy('users.display_name')
      .execute();
    return rows.map(toDirectoryUser);
  }

  /**
   * The user's channels with unread state. Both counts come from subqueries capped at
   * UNREAD_COUNT_CAP rows, so a channel with a huge backlog costs the same as a small one.
   */
  async listForUser(
    userId: string,
    options: {
      channelId?: string;
      guildId?: string;
      dmsOnly?: boolean;
      includeArchived?: boolean;
    } = {},
  ): Promise<ChannelSummary[]> {
    const { rows } = await sql<SummaryRow>`
      select c.id, c.guild_id, c.kind, c.name, c.topic, c.is_private, c.created_by,
        cm.last_read_message_id,
        (select max(m.id) from messages m where m.channel_id = c.id) as last_message_id,
        (select count(*)::int from (
          select 1 from messages m
          where m.channel_id = c.id
            and m.id > coalesce(cm.last_read_message_id, 0)
            and m.author_id <> ${userId}
            and m.deleted_at is null
          limit ${UNREAD_COUNT_CAP}
        ) unread) as unread_count,
        (select count(*)::int from (
          select 1 from message_mentions mm
          join messages m on m.id = mm.message_id
          where mm.user_id = ${userId}
            and mm.message_id > coalesce(cm.last_read_message_id, 0)
            and m.channel_id = c.id
            and m.deleted_at is null
          limit ${UNREAD_COUNT_CAP}
        ) mentions) as mention_count
      from channel_members cm
      join channels c on c.id = cm.channel_id
      where cm.user_id = ${userId}
        ${options.includeArchived ? sql`` : sql`and c.archived_at is null`}
        ${options.channelId ? sql`and c.id = ${options.channelId}` : sql``}
        ${options.guildId ? sql`and c.guild_id = ${options.guildId}` : sql``}
        ${options.dmsOnly ? sql`and c.kind = 'dm'` : sql``}
      order by c.kind = 'dm', c.name
    `.execute(this.db);

    const dmIds = rows.filter((row) => row.kind === 'dm').map((row) => row.id);
    const dmUsers = await this.dmUsers(dmIds, userId);
    return rows.map((row) => ({
      id: row.id,
      guildId: row.guild_id,
      kind: row.kind,
      name: row.name,
      topic: row.topic,
      isPrivate: row.is_private,
      createdBy: row.created_by,
      dmUser: dmUsers.get(row.id) ?? null,
      unreadCount: row.unread_count,
      mentionCount: row.mention_count,
      lastMessageId: row.last_message_id,
      lastReadMessageId: row.last_read_message_id,
    }));
  }

  /** Any guild member can create channels. Public ones appear for every member of the guild. */
  async create(actor: Actor, guildId: string, body: CreateChannelBody): Promise<ChannelSummary> {
    await this.requireGuildMember(guildId, actor.id);
    const isPrivate = body.isPrivate ?? false;
    let row: ChannelRow;
    let memberIds: string[];
    try {
      ({ row, memberIds } = await this.db.transaction().execute(async (trx) => {
        const channel = await trx
          .insertInto('channels')
          .values({
            guild_id: guildId,
            name: body.name,
            topic: body.topic ?? null,
            is_private: isPrivate,
            created_by: actor.id,
            dm_key: null,
            archived_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const { rows } = await sql<{ user_id: string }>`
          insert into channel_members (channel_id, user_id, last_read_message_id)
          select ${channel.id}, gm.user_id, null from guild_members gm
          where gm.guild_id = ${guildId} and (not ${isPrivate} or gm.user_id = ${actor.id})
          returning user_id
        `.execute(trx);
        return { row: channel, memberIds: rows.map((r) => r.user_id) };
      }));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'name_taken', 'A channel with that name already exists here');
      }
      throw error;
    }
    const summary = freshSummary(row);
    await Promise.all(
      memberIds.map((userId) =>
        this.events.toUser(userId, { type: 'channel.joined', channel: summary }),
      ),
    );
    return summary;
  }

  async update(actor: Actor, channelId: string, body: UpdateChannelBody): Promise<Channel> {
    const channel = await this.requireMember(channelId, actor.id);
    if (channel.kind === 'dm') {
      throw new AppError(400, 'dm_immutable', 'Direct messages cannot be changed');
    }
    if (!(await this.canManage(actor, channel))) {
      throw new AppError(
        403,
        'forbidden',
        'Only the channel creator, the guild owner or an admin can change this channel',
      );
    }

    let updated: ChannelRow;
    try {
      updated = await this.db
        .updateTable('channels')
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.topic !== undefined && { topic: body.topic || null }),
          ...(body.archived !== undefined && {
            archived_at: body.archived ? new Date() : null,
          }),
        })
        .where('id', '=', channelId)
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'name_taken', 'A channel with that name already exists');
      }
      throw error;
    }

    const archivedChanged = (channel.archived_at === null) !== (updated.archived_at === null);
    const memberIds = await this.memberIds(channelId);
    await Promise.all(
      memberIds.map(async (userId) => {
        if (archivedChanged && updated.archived_at) {
          await this.events.toUser(userId, { type: 'channel.removed', channelId });
        } else if (archivedChanged) {
          await this.announceJoin(userId, channelId);
        } else {
          await this.events.toUser(userId, {
            type: 'channel.updated',
            channel: toChannel(updated),
          });
        }
      }),
    );
    return toChannel(updated);
  }

  /** Adds a guild member to a private channel; public channels already include everyone. */
  async addMember(actor: Actor, channelId: string, userId: string): Promise<void> {
    const channel = await this.requireMember(channelId, actor.id);
    if (channel.kind === 'dm') {
      throw new AppError(400, 'dm_immutable', 'Direct messages have exactly two members');
    }
    if (!channel.is_private) {
      throw new AppError(400, 'public_channel', 'Everyone in the guild is already in this channel');
    }
    if (channel.archived_at) throw new AppError(409, 'channel_archived', 'Channel is archived');
    const target = await this.db
      .selectFrom('guild_members')
      .select('user_id')
      .where('guild_id', '=', channel.guild_id ?? '0')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!target) throw new AppError(404, 'user_not_found', 'That user is not in this guild');
    if (await this.insertMember(channelId, userId)) await this.announceJoin(userId, channelId);
  }

  /** Members can leave themselves; removing someone else needs creator, guild owner or admin. */
  async removeMember(actor: Actor, channelId: string, userId: string): Promise<void> {
    const channel = await this.requireMember(channelId, actor.id);
    if (channel.kind === 'dm') {
      throw new AppError(400, 'dm_immutable', 'Direct messages cannot be left');
    }
    if (!channel.is_private) {
      throw new AppError(400, 'public_channel', 'Public channels follow guild membership');
    }
    if (userId !== actor.id && !(await this.canManage(actor, channel))) {
      throw new AppError(
        403,
        'forbidden',
        'Only the creator, guild owner or an admin can remove members',
      );
    }
    const removed = await this.db
      .deleteFrom('channel_members')
      .where('channel_id', '=', channelId)
      .where('user_id', '=', userId)
      .returning('user_id')
      .executeTakeFirst();
    if (removed) await this.events.toUser(userId, { type: 'channel.removed', channelId });
  }

  /** Leaves a private channel; the caller is by definition removing themselves. */
  leave(actor: Actor, channelId: string): Promise<void> {
    return this.removeMember(actor, channelId, actor.id);
  }

  /**
   * Moves the read marker forward only: `greatest` ignores NULL, so the first call sets it and
   * a stale call from an older tab can never move it back.
   */
  async markRead(actor: Actor, channelId: string, messageId: string): Promise<ReadState> {
    await this.requireMember(channelId, actor.id);
    const inChannel = await this.db
      .selectFrom('messages')
      .select('id')
      .where('id', '=', messageId)
      .where('channel_id', '=', channelId)
      .executeTakeFirst();
    if (!inChannel) throw new AppError(400, 'invalid_message', 'Message is not in this channel');

    await sql`
      update channel_members
      set last_read_message_id = greatest(last_read_message_id, ${messageId}::bigint)
      where channel_id = ${channelId} and user_id = ${actor.id}
    `.execute(this.db);

    const [summary] = await this.listForUser(actor.id, { channelId, includeArchived: true });
    if (!summary?.lastReadMessageId) throw new Error('read state missing after update');
    const state: ReadState = {
      channelId,
      lastReadMessageId: summary.lastReadMessageId,
      unreadCount: summary.unreadCount,
      mentionCount: summary.mentionCount,
    };
    await this.events.toUser(actor.id, { type: 'read.updated', ...state });
    return state;
  }

  /** Idempotent: the dm_key unique index makes the pair map to exactly one channel. */
  async openDm(actor: Actor, otherId: string): Promise<ChannelSummary> {
    if (otherId === actor.id) {
      throw new AppError(400, 'invalid_request', 'You cannot start a conversation with yourself');
    }
    const other = await this.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', otherId)
      .executeTakeFirst();
    if (!other) throw new AppError(404, 'user_not_found', 'User not found');

    const shared = await this.db
      .selectFrom('guild_members as theirs')
      .innerJoin('guild_members as mine', 'mine.guild_id', 'theirs.guild_id')
      .select('theirs.guild_id')
      .where('theirs.user_id', '=', otherId)
      .where('mine.user_id', '=', actor.id)
      .limit(1)
      .executeTakeFirst();
    if (!shared) throw new AppError(403, 'forbidden', 'You share no guild with that user');

    const [low, high] =
      BigInt(actor.id) < BigInt(otherId) ? [actor.id, otherId] : [otherId, actor.id];
    const dmKey = `${low}:${high}`;
    const { id, created } = await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('channels')
        .values({
          kind: 'dm',
          guild_id: null,
          is_private: true,
          dm_key: dmKey,
          created_by: actor.id,
          name: null,
          topic: null,
          archived_at: null,
        })
        .onConflict((oc) => oc.column('dm_key').doNothing())
        .returning('id')
        .executeTakeFirst();
      const channel =
        inserted ??
        (await trx
          .selectFrom('channels')
          .select('id')
          .where('dm_key', '=', dmKey)
          .executeTakeFirstOrThrow());
      await trx
        .insertInto('channel_members')
        .values([
          { channel_id: channel.id, user_id: actor.id, last_read_message_id: null },
          { channel_id: channel.id, user_id: otherId, last_read_message_id: null },
        ])
        .onConflict((oc) => oc.doNothing())
        .execute();
      return { id: channel.id, created: inserted !== undefined };
    });

    if (created) await this.announceJoin(otherId, id);
    return this.announceJoin(actor.id, id);
  }

  private async canManage(actor: Actor, channel: ChannelRow): Promise<boolean> {
    if (actor.isAdmin || channel.created_by === actor.id) return true;
    const guild = await this.db
      .selectFrom('guilds')
      .select('owner_id')
      .where('id', '=', channel.guild_id ?? '0')
      .executeTakeFirst();
    return guild?.owner_id === actor.id;
  }

  private async requireGuildMember(guildId: string, userId: string): Promise<void> {
    const guild = await this.db
      .selectFrom('guilds')
      .select('id')
      .where('id', '=', guildId)
      .executeTakeFirst();
    if (!guild) throw new AppError(404, 'guild_not_found', 'Guild not found');
    const member = await this.db
      .selectFrom('guild_members')
      .select('user_id')
      .where('guild_id', '=', guildId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!member) throw new AppError(403, 'forbidden', 'You are not a member of this guild');
  }

  private async insertMember(channelId: string, userId: string): Promise<boolean> {
    const { rows } = await sql<{ user_id: string }>`
      insert into channel_members (channel_id, user_id, last_read_message_id)
      values (${channelId}, ${userId},
              (select max(m.id) from messages m where m.channel_id = ${channelId}))
      on conflict do nothing
      returning user_id
    `.execute(this.db);
    return rows.length > 0;
  }

  async announceJoin(userId: string, channelId: string): Promise<ChannelSummary> {
    const [summary] = await this.listForUser(userId, { channelId });
    if (!summary) throw new Error('channel summary missing after join');
    await this.events.toUser(userId, { type: 'channel.joined', channel: summary });
    return summary;
  }

  private async dmUsers(channelIds: string[], viewerId: string): Promise<Map<string, User>> {
    if (channelIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('channel_members')
      .innerJoin('users', 'users.id', 'channel_members.user_id')
      .select('channel_members.channel_id')
      .selectAll('users')
      .where('channel_members.channel_id', 'in', channelIds)
      .where('channel_members.user_id', '<>', viewerId)
      .execute();
    return new Map(rows.map((row) => [row.channel_id, toUser(toDirectoryUser(row))]));
  }
}
