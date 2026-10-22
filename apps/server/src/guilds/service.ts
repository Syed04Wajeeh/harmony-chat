import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  UNREAD_COUNT_CAP,
  type DirectoryUser,
  type Guild,
  type GuildMember,
  type GuildSummary,
  type Invite,
  type InvitePreview,
  type PresenceStatus,
  type UpdateGuildBody,
} from '@harmony/shared';
import { toDirectoryUser } from '../auth/user-store.js';
import type { ChannelService } from '../channels/service.js';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import { enqueueEvent } from '../events/outbox.js';
import { attachmentUrl } from '../messages/reader.js';
import type { PresenceService } from '../presence/service.js';
import type { EventBus } from '../realtime/events.js';
import type { Storage } from '../uploads/storage.js';
import { addGuildMember, createGuildWithGeneral } from './membership.js';

type Actor = Pick<DirectoryUser, 'id' | 'isAdmin'>;

interface GuildRow {
  id: string;
  name: string;
  owner_id: string;
  icon_attachment_id: string | null;
  icon_filename: string | null;
  member_count: number;
}

const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const INVITE_CODE_LENGTH = 10;

const toGuild = (row: GuildRow): Guild => ({
  id: row.id,
  name: row.name,
  iconUrl:
    row.icon_attachment_id && row.icon_filename
      ? attachmentUrl(row.icon_attachment_id, row.icon_filename)
      : null,
  ownerId: row.owner_id,
  memberCount: row.member_count,
});

const notFound = () => new AppError(404, 'guild_not_found', 'Guild not found');

export class GuildService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly events: EventBus,
    private readonly channels: ChannelService,
    private readonly presence: PresenceService,
    private readonly storage: Storage,
  ) {}

  /** The user's guilds, each with their unread and mention counts summed over its channels. */
  async list(userId: string, onlyGuildId?: string): Promise<GuildSummary[]> {
    const { rows } = await sql<GuildRow>`
      select g.id, g.name, g.owner_id, g.icon_attachment_id, a.filename as icon_filename,
        (select count(*)::int from guild_members m where m.guild_id = g.id) as member_count
      from guild_members gm
      join guilds g on g.id = gm.guild_id
      left join attachments a on a.id = g.icon_attachment_id
      where gm.user_id = ${userId}
        ${onlyGuildId ? sql`and g.id = ${onlyGuildId}` : sql``}
      order by g.name, g.id
    `.execute(this.db);
    if (rows.length === 0) return [];

    const totals = new Map<string, { unread: number; mentions: number }>();
    for (const channel of await this.channels.listForUser(userId)) {
      if (!channel.guildId) continue;
      const total = totals.get(channel.guildId) ?? { unread: 0, mentions: 0 };
      total.unread += channel.unreadCount;
      total.mentions += channel.mentionCount;
      totals.set(channel.guildId, total);
    }
    return rows.map((row) => {
      const total = totals.get(row.id);
      return {
        ...toGuild(row),
        unreadCount: Math.min(total?.unread ?? 0, UNREAD_COUNT_CAP),
        mentionCount: Math.min(total?.mentions ?? 0, UNREAD_COUNT_CAP),
      };
    });
  }

  async create(actor: Actor, name: string): Promise<GuildSummary> {
    const { guildId, channelId } = await this.db
      .transaction()
      .execute((trx) => createGuildWithGeneral(trx, name, actor.id));
    return this.announceJoin(actor.id, guildId, channelId);
  }

  async update(actor: Actor, guildId: string, body: UpdateGuildBody): Promise<Guild> {
    await this.requireManager(actor, guildId);
    if (body.iconAttachmentId) {
      const icon = await this.db
        .selectFrom('attachments')
        .select('id')
        .where('id', '=', body.iconAttachmentId)
        .where('uploader_id', '=', actor.id)
        .where('message_id', 'is', null)
        .where('content_type', 'in', RASTER_TYPES)
        .executeTakeFirst();
      if (!icon) {
        throw new AppError(400, 'invalid_icon', 'The icon must be an image you uploaded');
      }
    }
    await this.db
      .updateTable('guilds')
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.iconAttachmentId !== undefined && { icon_attachment_id: body.iconAttachmentId }),
      })
      .where('id', '=', guildId)
      .execute();

    const guild = await this.load(guildId);
    await this.toMembers(guildId, (userId) =>
      this.events.toUser(userId, { type: 'guild.updated', guild }),
    );
    return guild;
  }

  async delete(actor: Actor, guildId: string): Promise<void> {
    await this.requireManager(actor, guildId);
    const memberIds = await this.memberIds(guildId);
    const channelRows = await this.db
      .selectFrom('channels')
      .select('id')
      .where('guild_id', '=', guildId)
      .execute();
    const files = await this.db
      .selectFrom('attachments')
      .innerJoin('messages', 'messages.id', 'attachments.message_id')
      .innerJoin('channels', 'channels.id', 'messages.channel_id')
      .select('attachments.storage_key')
      .where('channels.guild_id', '=', guildId)
      .execute();

    await this.db.deleteFrom('guilds').where('id', '=', guildId).execute();

    await Promise.all(
      memberIds.flatMap((userId) => [
        ...channelRows.map((channel) =>
          this.events.toUser(userId, { type: 'channel.removed', channelId: channel.id }),
        ),
        this.events.toUser(userId, { type: 'guild.removed', guildId }),
      ]),
    );
    await Promise.allSettled(files.map((file) => this.storage.delete(file.storage_key)));
  }

  /** The owner cannot leave: they must delete the guild (ownership transfer comes later). */
  async leave(actor: Actor, guildId: string): Promise<void> {
    const guild = await this.requireMember(guildId, actor.id);
    if (guild.owner_id === actor.id) {
      throw new AppError(400, 'owner_cannot_leave', 'Delete the guild instead of leaving it');
    }
    const removedChannels = await this.db.transaction().execute(async (trx) => {
      const { rows } = await sql<{ channel_id: string }>`
        delete from channel_members cm
        using channels c
        where cm.channel_id = c.id and c.guild_id = ${guildId} and cm.user_id = ${actor.id}
        returning cm.channel_id
      `.execute(trx);
      await trx
        .deleteFrom('guild_members')
        .where('guild_id', '=', guildId)
        .where('user_id', '=', actor.id)
        .execute();
      await enqueueEvent(trx, {
        guildId,
        type: 'guild.member_left',
        data: { userId: actor.id },
      });
      return rows.map((row) => row.channel_id);
    });

    await Promise.all(
      removedChannels.map((channelId) =>
        this.events.toUser(actor.id, { type: 'channel.removed', channelId }),
      ),
    );
    await this.events.toUser(actor.id, { type: 'guild.removed', guildId });
    await this.toMembers(guildId, (userId) =>
      this.events.toUser(userId, { type: 'guild.member_left', guildId, userId: actor.id }),
    );
  }

  async members(actor: Actor, guildId: string): Promise<GuildMember[]> {
    await this.requireMember(guildId, actor.id);
    const [rows, online] = await Promise.all([
      this.db
        .selectFrom('guild_members')
        .innerJoin('users', 'users.id', 'guild_members.user_id')
        .selectAll('users')
        .select('guild_members.joined_at')
        .where('guild_members.guild_id', '=', guildId)
        .orderBy('users.display_name')
        .execute(),
      this.presence.snapshot(),
    ]);
    const status = new Map(online.map((entry) => [entry.userId, entry.status]));
    return rows.map((row) => ({
      ...toDirectoryUser(row),
      status: status.get(row.id) ?? ('offline' satisfies PresenceStatus),
      joinedAt: row.joined_at.toISOString(),
    }));
  }

  async channelsOf(actor: Actor, guildId: string) {
    await this.requireMember(guildId, actor.id);
    return this.channels.listForUser(actor.id, { guildId });
  }

  async createInvite(
    actor: Actor,
    guildId: string,
    options: { maxUses?: number | undefined; expiresInSeconds?: number | undefined },
  ): Promise<Invite> {
    await this.requireMember(guildId, actor.id);
    const expiresAt = options.expiresInSeconds
      ? new Date(Date.now() + options.expiresInSeconds * 1000)
      : null;
    const row = await this.db
      .insertInto('guild_invites')
      .values({
        code: randomBytes(8).toString('base64url').slice(0, INVITE_CODE_LENGTH),
        guild_id: guildId,
        created_by: actor.id,
        expires_at: expiresAt,
        max_uses: options.maxUses ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      code: row.code,
      guildId: row.guild_id,
      createdBy: row.created_by,
      expiresAt: row.expires_at?.toISOString() ?? null,
      maxUses: row.max_uses,
      uses: row.uses,
      createdAt: row.created_at.toISOString(),
    };
  }

  async previewInvite(user: Actor, code: string): Promise<InvitePreview> {
    const invite = await this.db
      .selectFrom('guild_invites')
      .selectAll()
      .where('code', '=', code)
      .executeTakeFirst();
    if (!invite) throw new AppError(404, 'invite_not_found', 'Invite not found');
    const exhausted = invite.max_uses !== null && invite.uses >= invite.max_uses;
    if (exhausted || (invite.expires_at && invite.expires_at <= new Date())) {
      throw new AppError(410, 'invite_expired', 'This invite is no longer valid');
    }
    const guild = await this.load(invite.guild_id);
    const member = await this.db
      .selectFrom('guild_members')
      .select('user_id')
      .where('guild_id', '=', invite.guild_id)
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    return {
      code,
      guild: { id: guild.id, name: guild.name, iconUrl: guild.iconUrl },
      memberCount: guild.memberCount,
      alreadyMember: member !== undefined,
    };
  }

  /**
   * Joins the guild behind an invite. The use is consumed by one conditional UPDATE, so
   * concurrent accepts cannot exceed max_uses; if the join itself did not happen (already a
   * member) nothing is consumed, which makes accepting twice harmless.
   */
  async acceptInvite(user: DirectoryUser, code: string): Promise<GuildSummary> {
    const { guildId, joined } = await this.db.transaction().execute(async (trx) => {
      const invite = await trx
        .selectFrom('guild_invites')
        .select('guild_id')
        .where('code', '=', code)
        .executeTakeFirst();
      if (!invite) throw new AppError(404, 'invite_not_found', 'Invite not found');

      const added = await addGuildMember(trx, invite.guild_id, user.id);
      if (added) {
        const used = await trx
          .updateTable('guild_invites')
          .set({ uses: sql`uses + 1` })
          .where('code', '=', code)
          .where((eb) =>
            eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]),
          )
          .where((eb) => eb.or([eb('max_uses', 'is', null), eb('uses', '<', eb.ref('max_uses'))]))
          .returning('code')
          .executeTakeFirst();
        if (!used) throw new AppError(410, 'invite_expired', 'This invite is no longer valid');
      }
      return { guildId: invite.guild_id, joined: added };
    });

    const [summary] = await this.list(user.id, guildId);
    if (!summary) throw new Error('guild missing after accept');
    if (joined) {
      await this.events.toUser(user.id, { type: 'guild.joined', guild: summary });
      await this.toMembers(guildId, (memberId) =>
        memberId === user.id
          ? Promise.resolve()
          : this.events.toUser(memberId, { type: 'guild.member_joined', guildId, user }),
      );
    }
    return summary;
  }

  private async announceJoin(userId: string, guildId: string, channelId: string) {
    await this.channels.announceJoin(userId, channelId);
    const [summary] = await this.list(userId, guildId);
    if (!summary) throw new Error('guild missing after create');
    await this.events.toUser(userId, { type: 'guild.joined', guild: summary });
    return summary;
  }

  private async load(guildId: string): Promise<Guild> {
    const { rows } = await sql<GuildRow>`
      select g.id, g.name, g.owner_id, g.icon_attachment_id, a.filename as icon_filename,
        (select count(*)::int from guild_members m where m.guild_id = g.id) as member_count
      from guilds g left join attachments a on a.id = g.icon_attachment_id
      where g.id = ${guildId}
    `.execute(this.db);
    const row = rows[0];
    if (!row) throw notFound();
    return toGuild(row);
  }

  private async requireMember(guildId: string, userId: string) {
    const guild = await this.db
      .selectFrom('guilds')
      .select(['id', 'owner_id'])
      .where('id', '=', guildId)
      .executeTakeFirst();
    if (!guild) throw notFound();
    const member = await this.db
      .selectFrom('guild_members')
      .select('user_id')
      .where('guild_id', '=', guildId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!member) throw new AppError(403, 'forbidden', 'You are not a member of this guild');
    return guild;
  }

  /** The owner manages a guild; instance admins can too, as a moderation override. */
  async requireManager(actor: Actor, guildId: string) {
    const guild = await this.db
      .selectFrom('guilds')
      .select(['id', 'owner_id'])
      .where('id', '=', guildId)
      .executeTakeFirst();
    if (!guild) throw notFound();
    if (guild.owner_id !== actor.id && !actor.isAdmin) {
      const member = await this.db
        .selectFrom('guild_members')
        .select('user_id')
        .where('guild_id', '=', guildId)
        .where('user_id', '=', actor.id)
        .executeTakeFirst();
      throw member
        ? new AppError(403, 'forbidden', 'Only the guild owner can do that')
        : new AppError(403, 'forbidden', 'You are not a member of this guild');
    }
    return guild;
  }

  private async memberIds(guildId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('guild_members')
      .select('user_id')
      .where('guild_id', '=', guildId)
      .execute();
    return rows.map((row) => row.user_id);
  }

  private async toMembers(guildId: string, publish: (userId: string) => Promise<unknown>) {
    await Promise.all((await this.memberIds(guildId)).map(publish));
  }
}
