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
import type { DomainEvents } from '../modules/domain-events.js';
import { putOverwrite } from '../permissions/overwrites.js';
import { reconcileAccess, type AccessDiff } from '../permissions/reconcile.js';
import type { PermissionService } from '../permissions/service.js';
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
    private readonly domain: DomainEvents,
    private readonly perms: PermissionService,
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

  /**
   * Needs `create_channels`. A private channel is a channel @everyone may not view, with the
   * creator allowed in; who ends up in `channel_members` is decided by the permission rules.
   */
  async create(actor: Actor, guildId: string, body: CreateChannelBody): Promise<ChannelSummary> {
    await this.perms.require(actor, guildId, 'create_channels');
    const isPrivate = body.isPrivate ?? false;
    const { everyone } = await this.perms.requireAccess(guildId);
    let row: ChannelRow;
    let diff: AccessDiff;
    try {
      ({ row, diff } = await this.db.transaction().execute(async (trx) => {
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
        if (isPrivate) {
          await putOverwrite(trx, channel.id, 'role', everyone.id, [], ['view_channel']);
          await putOverwrite(trx, channel.id, 'member', actor.id, ['view_channel'], []);
        }
        return {
          row: channel,
          diff: await reconcileAccess(trx, guildId, { channelIds: [channel.id] }),
        };
      }));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'name_taken', 'A channel with that name already exists here');
      }
      throw error;
    }
    await this.perms.changed(guildId);
    const summary = freshSummary(row);
    await Promise.all(
      diff.added.map(({ userId }) =>
        this.events.toUser(userId, { type: 'channel.joined', channel: summary }),
      ),
    );
    this.domain.emit('channel.created', { guildId, channel: toChannel(row) });
    return summary;
  }

  /** Tells the users whose access changed; call once the change is committed. */
  async applyAccess(diff: AccessDiff): Promise<void> {
    await Promise.all([
      ...diff.added.map(({ userId, channelId }) => this.announceJoin(userId, channelId)),
      ...diff.removed.map(({ userId, channelId }) =>
        this.events.toUser(userId, { type: 'channel.removed', channelId }),
      ),
    ]);
  }

  async update(actor: Actor, channelId: string, body: UpdateChannelBody): Promise<Channel> {
    const channel = await this.requireMember(channelId, actor.id);
    if (channel.kind === 'dm') {
      throw new AppError(400, 'dm_immutable', 'Direct messages cannot be changed');
    }
    if (!(await this.canManage(actor, channel))) {
      throw new AppError(
        403,
        'missing_permission',
        'Only the channel creator or someone with manage_channels can change this channel',
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

  /** Adds a guild member to a private channel by allowing them to view it. */
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
    await this.setViewAccess(channel, userId, true);
  }

  /** Members can leave themselves; removing someone else needs the creator or manage_channels. */
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
        'missing_permission',
        'Only the creator or someone with manage_channels can remove members',
      );
    }
    await this.setViewAccess(channel, userId, false);
  }

  /** A member overwrite that allows (or denies) viewing, keeping whatever else it holds. */
  private async setViewAccess(channel: ChannelRow, userId: string, allowed: boolean) {
    const guildId = channel.guild_id ?? '0';
    const diff = await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('channel_overwrites')
        .select(['allow', 'deny'])
        .where('channel_id', '=', channel.id)
        .where('target_type', '=', 'member')
        .where('target_id', '=', userId)
        .executeTakeFirst();
      const others = (keys: readonly string[] | undefined) =>
        (keys ?? []).filter((key) => key !== 'view_channel');
      await putOverwrite(
        trx,
        channel.id,
        'member',
        userId,
        allowed ? ['view_channel', ...others(current?.allow)] : others(current?.allow),
        allowed ? others(current?.deny) : ['view_channel', ...others(current?.deny)],
      );
      return reconcileAccess(trx, guildId, { channelIds: [channel.id], userIds: [userId] });
    });
    await this.perms.changed(guildId);
    await this.applyAccess(diff);
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
      .select(['id', 'kind'])
      .where('id', '=', otherId)
      .executeTakeFirst();
    if (!other) throw new AppError(404, 'user_not_found', 'User not found');

    // Anyone who signed in can be messaged (the members directory lists them all); bots are only
    // reachable from a guild they are in.
    const shared =
      other.kind === 'bot' &&
      (await this.db
        .selectFrom('guild_members as theirs')
        .innerJoin('guild_members as mine', 'mine.guild_id', 'theirs.guild_id')
        .select('theirs.guild_id')
        .where('theirs.user_id', '=', otherId)
        .where('mine.user_id', '=', actor.id)
        .limit(1)
        .executeTakeFirst());
    if (other.kind === 'bot' && !shared) {
      throw new AppError(403, 'forbidden', 'You share no guild with that bot');
    }

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
    if (channel.created_by === actor.id) return true;
    return channel.guild_id
      ? this.perms.has(actor, channel.guild_id, 'manage_channels', channel.id)
      : false;
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
