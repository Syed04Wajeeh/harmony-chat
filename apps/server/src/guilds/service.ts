import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  UNREAD_COUNT_CAP,
  type DirectoryUser,
  type Guild,
  type GuildMember,
  type NicknameBody,
  type GuildSummary,
  type Invite,
  type InvitePreview,
  type PresenceStatus,
  type UpdateGuildBody,
  type User,
} from '@harmony/shared';
import { toDirectoryUser } from '../auth/user-store.js';
import type { ChannelService } from '../channels/service.js';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import { enqueueEvent } from '../events/outbox.js';
import { attachmentUrl } from '../messages/reader.js';
import type { DomainEvents } from '../modules/domain-events.js';
import type { PresenceService } from '../presence/service.js';
import type { EventBus } from '../realtime/events.js';
import type { Storage } from '../uploads/storage.js';
import { canModerate, memberRank, rankOf, rolesOf } from '../permissions/access.js';
import { reconcileAccess } from '../permissions/reconcile.js';
import type { PermissionService } from '../permissions/service.js';
import { addGuildMember, createGuildWithGeneral } from './membership.js';

type Actor = Pick<DirectoryUser, 'id' | 'isAdmin'>;

interface GuildRow {
  id: string;
  name: string;
  owner_id: string;
  icon_attachment_id: string | null;
  icon_filename: string | null;
  accent_color: number | null;
  banner_attachment_id: string | null;
  banner_filename: string | null;
  description: string | null;
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
  accentColor: row.accent_color,
  bannerUrl:
    row.banner_attachment_id && row.banner_filename
      ? attachmentUrl(row.banner_attachment_id, row.banner_filename)
      : null,
  description: row.description,
  ownerId: row.owner_id,
  memberCount: row.member_count,
});

const toUser = ({ id, login, displayName, avatarUrl }: DirectoryUser): User => ({
  id,
  login,
  displayName,
  avatarUrl,
});

const notFound = () => new AppError(404, 'guild_not_found', 'Guild not found');

export class GuildService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly events: EventBus,
    private readonly channels: ChannelService,
    private readonly presence: PresenceService,
    private readonly storage: Storage,
    private readonly domain: DomainEvents,
    private readonly perms: PermissionService,
  ) {}

  /** The user's guilds, each with their unread and mention counts summed over its channels. */
  async list(userId: string, onlyGuildId?: string): Promise<GuildSummary[]> {
    const { rows } = await sql<GuildRow>`
      select g.id, g.name, g.owner_id, g.icon_attachment_id, a.filename as icon_filename,
        g.accent_color, g.banner_attachment_id, b.filename as banner_filename, g.description,
        (select count(*)::int from guild_members m where m.guild_id = g.id) as member_count
      from guild_members gm
      join guilds g on g.id = gm.guild_id
      left join attachments a on a.id = g.icon_attachment_id
      left join attachments b on b.id = g.banner_attachment_id
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
    await this.perms.require(actor, guildId, 'manage_guild');
    await this.requireImage(actor, body.iconAttachmentId, 'invalid_icon', 'The icon');
    await this.requireImage(actor, body.bannerAttachmentId, 'invalid_banner', 'The banner');
    await this.db
      .updateTable('guilds')
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.iconAttachmentId !== undefined && { icon_attachment_id: body.iconAttachmentId }),
        ...(body.bannerAttachmentId !== undefined && {
          banner_attachment_id: body.bannerAttachmentId,
        }),
        ...(body.accentColor !== undefined && { accent_color: body.accentColor }),
        ...(body.description !== undefined && { description: body.description || null }),
      })
      .where('id', '=', guildId)
      .execute();

    const guild = await this.load(guildId);
    await this.toMembers(guildId, (userId) =>
      this.events.toUser(userId, { type: 'guild.updated', guild }),
    );
    return guild;
  }

  private async requireImage(
    actor: Actor,
    attachmentId: string | null | undefined,
    code: string,
    subject: string,
  ): Promise<void> {
    if (!attachmentId) return;
    const image = await this.db
      .selectFrom('attachments')
      .select('id')
      .where('id', '=', attachmentId)
      .where('uploader_id', '=', actor.id)
      .where('message_id', 'is', null)
      .where('content_type', 'in', RASTER_TYPES)
      .executeTakeFirst();
    if (!image) throw new AppError(400, code, `${subject} must be an image you uploaded`);
  }

  /** Only the owner (or an instance admin, as moderation) deletes a guild. */
  async delete(actor: Actor, guildId: string): Promise<void> {
    await this.requireOwner(actor, guildId);
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

  /** The owner cannot leave: they transfer the guild or delete it. */
  async leave(actor: Actor, guildId: string): Promise<void> {
    const guild = await this.requireMember(guildId, actor.id);
    if (guild.owner_id === actor.id) {
      throw new AppError(400, 'owner_cannot_leave', 'Transfer the guild or delete it instead');
    }
    await this.detach(guildId, actor.id);
  }

  /** Removes a member: needs `kick_members`, and the target must rank below the actor. */
  async kick(actor: Actor, guildId: string, userId: string): Promise<void> {
    await this.perms.require(actor, guildId, 'kick_members');
    if (userId === actor.id) {
      throw new AppError(400, 'invalid_request', 'Leave the guild instead of kicking yourself');
    }
    const access = await this.perms.requireAccess(guildId);
    if (!access.members.has(userId)) throw new AppError(404, 'user_not_found', 'Not a member');
    if (!canModerate(rankOf(access, actor), memberRank(access, userId))) {
      throw new AppError(403, 'role_hierarchy', 'That member ranks at or above you');
    }
    await this.detach(guildId, userId);
  }

  private async detach(guildId: string, userId: string): Promise<void> {
    const removedChannels = await this.db.transaction().execute(async (trx) => {
      const { rows } = await sql<{ channel_id: string }>`
        delete from channel_members cm
        using channels c
        where cm.channel_id = c.id and c.guild_id = ${guildId} and cm.user_id = ${userId}
        returning cm.channel_id
      `.execute(trx);
      await sql`
        delete from channel_overwrites o using channels c
        where o.channel_id = c.id and c.guild_id = ${guildId}
          and o.target_type = 'member' and o.target_id = ${userId}
      `.execute(trx);
      await trx
        .deleteFrom('guild_members')
        .where('guild_id', '=', guildId)
        .where('user_id', '=', userId)
        .execute();
      await enqueueEvent(trx, { guildId, type: 'guild.member_left', data: { userId } });
      return rows.map((row) => row.channel_id);
    });
    await this.perms.changed(guildId);

    await Promise.all(
      removedChannels.map((channelId) =>
        this.events.toUser(userId, { type: 'channel.removed', channelId }),
      ),
    );
    await this.events.toUser(userId, { type: 'guild.removed', guildId });
    await this.toMembers(guildId, (memberId) =>
      this.events.toUser(memberId, { type: 'guild.member_left', guildId, userId }),
    );
    this.domain.emit('member.left', { guildId, userId });
  }

  /** Hands the guild to another human member. Only the owner can. */
  async transfer(actor: Actor, guildId: string, userId: string): Promise<Guild> {
    const guild = await this.requireMember(guildId, actor.id);
    if (guild.owner_id !== actor.id) {
      throw new AppError(403, 'forbidden', 'Only the guild owner can do that');
    }
    if (userId === actor.id) {
      throw new AppError(400, 'invalid_request', 'You already own this guild');
    }
    const target = await this.db
      .selectFrom('guild_members')
      .innerJoin('users', 'users.id', 'guild_members.user_id')
      .select('users.kind')
      .where('guild_members.guild_id', '=', guildId)
      .where('guild_members.user_id', '=', userId)
      .executeTakeFirst();
    if (!target) throw new AppError(404, 'user_not_found', 'That user is not in this guild');
    if (target.kind === 'bot') {
      throw new AppError(400, 'invalid_request', 'A bot cannot own a guild');
    }

    const diff = await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('guilds').set({ owner_id: userId }).where('id', '=', guildId).execute();
      // The new owner sees everything and the old one is an ordinary member now.
      return reconcileAccess(trx, guildId);
    });
    await this.perms.changed(guildId);
    const updated = await this.load(guildId);
    await this.toMembers(guildId, (memberId) =>
      this.events.toUser(memberId, { type: 'guild.updated', guild: updated }),
    );
    await this.channels.applyAccess(diff);
    return updated;
  }

  /** Your own nickname needs change_nickname; someone else's needs manage_nicknames and rank. */
  async setNickname(
    actor: Actor,
    guildId: string,
    userId: string,
    body: NicknameBody,
  ): Promise<void> {
    if (userId === actor.id) {
      await this.perms.require(actor, guildId, 'change_nickname');
    } else {
      await this.perms.require(actor, guildId, 'manage_nicknames');
      const access = await this.perms.requireAccess(guildId);
      if (!access.members.has(userId)) throw new AppError(404, 'user_not_found', 'Not a member');
      if (!canModerate(rankOf(access, actor), memberRank(access, userId))) {
        throw new AppError(403, 'role_hierarchy', 'That member ranks at or above you');
      }
    }
    const updated = await this.db
      .updateTable('guild_members')
      .set({ nickname: body.nickname })
      .where('guild_id', '=', guildId)
      .where('user_id', '=', userId)
      .returning('user_id')
      .executeTakeFirst();
    if (!updated) throw new AppError(404, 'user_not_found', 'Not a member');
    await this.perms.changed(guildId);
    await this.announceMember(guildId, userId);
  }

  /** Tells every member about a changed nickname or role set. */
  async announceMember(guildId: string, userId: string): Promise<void> {
    const [member, access] = await Promise.all([
      this.db
        .selectFrom('guild_members')
        .select('nickname')
        .where('guild_id', '=', guildId)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
      this.perms.requireAccess(guildId),
    ]);
    if (!member) return;
    await this.toMembers(guildId, (memberId) =>
      this.events.toUser(memberId, {
        type: 'guild.member_updated',
        guildId,
        userId,
        roleIds: access.members.get(userId)?.roleIds ?? [],
        nickname: member.nickname,
      }),
    );
  }

  async members(actor: Actor, guildId: string): Promise<GuildMember[]> {
    await this.requireMember(guildId, actor.id);
    const [rows, access] = await Promise.all([
      this.db
        .selectFrom('guild_members')
        .innerJoin('users', 'users.id', 'guild_members.user_id')
        .selectAll('users')
        .select(['guild_members.joined_at', 'guild_members.nickname'])
        .where('guild_members.guild_id', '=', guildId)
        .orderBy('users.display_name')
        .execute(),
      this.perms.requireAccess(guildId),
    ]);
    const online = await this.presence.statusesOf(rows.map((row) => row.id));
    const status = new Map(online.map((entry) => [entry.userId, entry.status]));
    return rows.map((row) => {
      const roles = rolesOf(access, row.id);
      const colored = roles.filter((role) => role.color !== null);
      const top = colored.reduce<(typeof colored)[number] | undefined>(
        (best, role) => (!best || role.position > best.position ? role : best),
        undefined,
      );
      return {
        ...toDirectoryUser(row),
        status: status.get(row.id) ?? ('offline' satisfies PresenceStatus),
        joinedAt: row.joined_at.toISOString(),
        roleIds: roles.map((role) => role.id),
        nickname: row.nickname,
        topRoleColor: top?.color ?? null,
      };
    });
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
    await this.perms.require(actor, guildId, 'create_invites');
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
      guild: {
        id: guild.id,
        name: guild.name,
        iconUrl: guild.iconUrl,
        accentColor: guild.accentColor,
        bannerUrl: guild.bannerUrl,
        description: guild.description,
      },
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
      this.domain.emit('member.joined', { guildId, user: toUser(user) });
    }
    return summary;
  }

  private async announceJoin(userId: string, guildId: string, channelId: string) {
    await this.channels.announceJoin(userId, channelId);
    const [summary] = await this.list(userId, guildId);
    if (!summary) throw new Error('guild missing after create');
    await this.events.toUser(userId, { type: 'guild.joined', guild: summary });
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'login', 'display_name', 'avatar_url'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    this.domain.emit('member.joined', {
      guildId,
      user: {
        id: user.id,
        login: user.login,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
      },
    });
    return summary;
  }

  private async load(guildId: string): Promise<Guild> {
    const { rows } = await sql<GuildRow>`
      select g.id, g.name, g.owner_id, g.icon_attachment_id, a.filename as icon_filename,
        g.accent_color, g.banner_attachment_id, b.filename as banner_filename, g.description,
        (select count(*)::int from guild_members m where m.guild_id = g.id) as member_count
      from guilds g
      left join attachments a on a.id = g.icon_attachment_id
      left join attachments b on b.id = g.banner_attachment_id
      where g.id = ${guildId}
    `.execute(this.db);
    const row = rows[0];
    if (!row) throw notFound();
    return toGuild(row);
  }

  async requireMember(guildId: string, userId: string) {
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

  /** The owner, or an instance admin as a moderation override. */
  async requireOwner(actor: Actor, guildId: string) {
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

  async toMembers(guildId: string, publish: (userId: string) => Promise<unknown>) {
    await Promise.all((await this.memberIds(guildId)).map(publish));
  }
}
