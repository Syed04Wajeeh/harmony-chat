import type { Redis } from 'ioredis';
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  isStatusExpired,
  parseCustomEmoji,
  statusExpiry,
  userTopic,
  type DirectoryUser,
  type Profile,
  type ProfileSummary,
  type UpdateProfileBody,
  type UserProfileResponse,
} from '@harmony/shared';
import type { UserStore } from '../auth/user-store.js';
import { toDirectoryUser } from '../auth/user-store.js';
import type { Database } from '../db/schema.js';
import type { EmojiService } from '../emoji/service.js';
import { AppError } from '../errors.js';
import { attachmentUrl } from '../messages/reader.js';
import type { PerkService } from '../perks/service.js';
import { isAnimatedImage } from '../uploads/animated.js';
import { readUpTo } from '../uploads/read.js';
import type { Storage } from '../uploads/storage.js';

const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Larger avatar files are refused before being read for animation detection. */
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const SWEEP_LOCK = 'harmony:lock:status-sweep';
const PUBLISH_BATCH = 500;

const notFound = () => new AppError(404, 'user_not_found', 'User not found');
const perkRequired = (message: string) => new AppError(403, 'perk_required', message);

type ProfileRow = Selectable<Database['user_profiles']>;

export class ProfileService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    private readonly storage: Storage,
    private readonly perks: PerkService,
    private readonly emoji: EmojiService,
    private readonly users: UserStore,
    private readonly options: { sweepMs: number; instanceId: string },
    private readonly log: { warn(o: object, m: string): void },
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((err: unknown) => this.log.warn({ err }, 'status sweep failed'));
    }, this.options.sweepMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Clears statuses whose time is up and tells the people who can see them. */
  async sweep(): Promise<number | null> {
    const lockMs = Math.max(1000, Math.floor(this.options.sweepMs / 2));
    const acquired = await this.redis.set(SWEEP_LOCK, this.options.instanceId, 'PX', lockMs, 'NX');
    if (acquired !== 'OK') return null;
    const cleared = await this.clearExpired();
    for (const userId of cleared) await this.announce(userId);
    return cleared.length;
  }

  private async clearExpired(userIds?: readonly string[]): Promise<string[]> {
    const rows = await this.db
      .updateTable('user_profiles')
      .set({
        status_emoji: null,
        status_text: null,
        status_expires_at: null,
        updated_at: sql`now()`,
      })
      .where('status_expires_at', '<=', sql<Date>`now()`)
      .$if(userIds !== undefined, (qb) => qb.where('user_id', 'in', [...(userIds ?? [])]))
      .returning('user_id')
      .execute();
    return rows.map((row) => row.user_id);
  }

  private summary(row: ProfileRow | undefined, hasPerks: boolean): ProfileSummary {
    const expired = row ? isStatusExpired(row.status_expires_at) : false;
    return {
      accentColor: row?.accent_color ?? null,
      statusEmoji: expired ? null : (row?.status_emoji ?? null),
      statusText: expired ? null : (row?.status_text ?? null),
      statusExpiresAt: expired ? null : (row?.status_expires_at?.toISOString() ?? null),
      hasPerks,
    };
  }

  /** Summaries for the given users, only for those who have anything worth showing. */
  async summaries(userIds: readonly string[]): Promise<Record<string, ProfileSummary>> {
    if (userIds.length === 0) return {};
    const ids = [...userIds];
    const [rows, granted] = await Promise.all([
      this.db.selectFrom('user_profiles').selectAll().where('user_id', 'in', ids).execute(),
      this.db
        .selectFrom('user_perks')
        .select('user_id')
        .distinct()
        .where('user_id', 'in', ids)
        .execute(),
    ]);
    const withPerks = new Set(granted.map((row) => row.user_id));
    const expired = rows.filter((row) => isStatusExpired(row.status_expires_at));
    if (expired.length > 0) {
      void this.clearExpired(expired.map((row) => row.user_id))
        .then((cleared) => Promise.all(cleared.map((id) => this.announce(id))))
        .catch((err: unknown) => this.log.warn({ err }, 'lazy status clear failed'));
    }
    const byUser = new Map(rows.map((row) => [row.user_id, row]));
    const result: Record<string, ProfileSummary> = {};
    for (const id of ids) {
      const summary = this.summary(byUser.get(id), withPerks.has(id));
      if (
        summary.accentColor !== null ||
        summary.statusEmoji !== null ||
        summary.statusText !== null ||
        summary.hasPerks
      ) {
        result[id] = summary;
      }
    }
    return result;
  }

  private async canSee(viewerId: string, targetId: string): Promise<boolean> {
    if (viewerId === targetId) return true;
    const shared = await sql<{ ok: boolean }>`
      select (
        exists (select 1 from guild_members a join guild_members b using (guild_id)
                where a.user_id = ${viewerId} and b.user_id = ${targetId})
        or exists (select 1 from channel_members a join channel_members b using (channel_id)
                   join channels c on c.id = a.channel_id
                   where c.kind = 'dm' and a.user_id = ${viewerId} and b.user_id = ${targetId})
      ) as ok
    `.execute(this.db);
    return shared.rows[0]?.ok === true;
  }

  async get(
    viewer: DirectoryUser,
    targetId: string,
    guildId?: string,
  ): Promise<UserProfileResponse> {
    if (!(await this.canSee(viewer.id, targetId))) throw notFound();
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', targetId)
      .executeTakeFirst();
    if (!user) throw notFound();
    let row = await this.db
      .selectFrom('user_profiles')
      .selectAll()
      .where('user_id', '=', targetId)
      .executeTakeFirst();
    if (row && isStatusExpired(row.status_expires_at)) {
      await this.clearExpired([targetId]);
      row = { ...row, status_emoji: null, status_text: null, status_expires_at: null };
      await this.announce(targetId);
    }
    const explicit = [...(await this.perks.explicit(targetId))];
    const imageIds = [row?.avatar_attachment_id, row?.banner_attachment_id].filter(
      (id): id is string => Boolean(id),
    );
    const images =
      imageIds.length === 0
        ? []
        : await this.db
            .selectFrom('attachments')
            .select(['id', 'filename'])
            .where('id', 'in', imageIds)
            .execute();
    const urlOf = (id: string | null | undefined) => {
      const image = images.find((item) => item.id === id);
      return image ? attachmentUrl(image.id, image.filename) : null;
    };

    let member: UserProfileResponse['member'] = null;
    if (guildId) {
      const [theirs, mine] = await Promise.all([
        this.db
          .selectFrom('guild_members')
          .select(['nickname', 'joined_at'])
          .where('guild_id', '=', guildId)
          .where('user_id', '=', targetId)
          .executeTakeFirst(),
        this.db
          .selectFrom('guild_members')
          .select('user_id')
          .where('guild_id', '=', guildId)
          .where('user_id', '=', viewer.id)
          .executeTakeFirst(),
      ]);
      if (theirs && mine) {
        const roles = await this.db
          .selectFrom('member_roles')
          .select('role_id')
          .where('guild_id', '=', guildId)
          .where('user_id', '=', targetId)
          .execute();
        member = {
          nickname: theirs.nickname,
          joinedAt: theirs.joined_at.toISOString(),
          roleIds: roles.map((role) => role.role_id),
        };
      }
    }
    const profile: Profile = {
      ...this.summary(row, explicit.length > 0),
      userId: targetId,
      avatarUrl: user.avatar_url,
      providerAvatarUrl: user.provider_avatar_url,
      avatarOverridden: user.avatar_overridden,
      bannerUrl: urlOf(row?.banner_attachment_id),
      bannerColor: row?.banner_color ?? null,
      bio: row?.bio ?? null,
      pronouns: row?.pronouns ?? null,
      perks: explicit,
    };
    return {
      profile,
      displayName: user.display_name,
      login: user.login,
      createdAt: user.created_at.toISOString(),
      member,
    };
  }

  private async requireImage(userId: string, id: string, what: string) {
    const file = await this.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', id)
      .where('uploader_id', '=', userId)
      .where('message_id', 'is', null)
      .where('content_type', 'in', RASTER_TYPES)
      .executeTakeFirst();
    if (!file)
      throw new AppError(400, 'invalid_image', `The ${what} must be an image you uploaded`);
    return file;
  }

  async update(user: DirectoryUser, body: UpdateProfileBody): Promise<void> {
    const set: Partial<Omit<ProfileRow, 'user_id' | 'updated_at'>> = {};
    let avatar: { url: string | null; overridden: boolean } | undefined;

    if (body.avatarAttachmentId !== undefined) {
      if (body.avatarAttachmentId === null) {
        set.avatar_attachment_id = null;
        avatar = { url: null, overridden: false };
      } else {
        const file = await this.requireImage(user.id, body.avatarAttachmentId, 'avatar');
        const bytes =
          Number(file.size_bytes) <= MAX_AVATAR_BYTES
            ? await readUpTo(await this.storage.get(file.storage_key), MAX_AVATAR_BYTES)
            : null;
        if (!bytes) throw new AppError(400, 'avatar_too_large', 'Avatars can be at most 8 MB');
        if (
          isAnimatedImage(bytes, file.content_type) &&
          !(await this.perks.has(user.id, 'animated_avatar'))
        ) {
          throw perkRequired(
            'Animated avatars need the animated avatar perk. Upload a still image instead.',
          );
        }
        set.avatar_attachment_id = file.id;
        avatar = { url: attachmentUrl(file.id, file.filename), overridden: true };
      }
    }
    if (body.bannerAttachmentId !== undefined) {
      if (body.bannerAttachmentId !== null) {
        if (!(await this.perks.has(user.id, 'profile_banner_image'))) {
          throw perkRequired(
            'Banner images need the banner image perk. Pick a banner color instead.',
          );
        }
        await this.requireImage(user.id, body.bannerAttachmentId, 'banner');
      }
      set.banner_attachment_id = body.bannerAttachmentId;
    }
    if (body.bannerColor !== undefined) set.banner_color = body.bannerColor;
    if (body.accentColor !== undefined) set.accent_color = body.accentColor;
    if (body.bio !== undefined) set.bio = body.bio || null;
    if (body.pronouns !== undefined) set.pronouns = body.pronouns || null;

    if (body.status !== undefined) {
      const status = body.status;
      const text = status?.text || null;
      let emoji = status?.emoji || null;
      if (emoji && parseCustomEmoji(emoji)) {
        const resolved = await this.emoji.statusToken(user.id, emoji);
        if (!resolved) {
          throw perkRequired(
            'Custom emoji in a status need the status emoji perk and a shared server.',
          );
        }
        emoji = resolved;
      }
      if (!status || (!emoji && !text)) {
        Object.assign(set, { status_emoji: null, status_text: null, status_expires_at: null });
      } else {
        Object.assign(set, {
          status_emoji: emoji,
          status_text: text,
          status_expires_at: statusExpiry(status.duration, new Date(), status.tzOffsetMinutes ?? 0),
        });
      }
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('user_profiles')
        .values({ ...set, user_id: user.id })
        .onConflict((oc) => oc.column('user_id').doUpdateSet({ ...set, updated_at: sql`now()` }))
        .execute();
      if (avatar) {
        await trx
          .updateTable('users')
          .set({
            avatar_url: avatar.overridden ? avatar.url : sql`provider_avatar_url`,
            avatar_overridden: avatar.overridden,
          })
          .where('id', '=', user.id)
          .execute();
      }
    });
    this.users.forget(user.id);
    await this.announce(user.id);
  }

  /** Everyone who shares a guild or a DM with the user, and the user. */
  private async audience(userId: string): Promise<string[]> {
    const rows = await sql<{ user_id: string }>`
      select ${userId}::bigint as user_id
      union select b.user_id from guild_members a join guild_members b using (guild_id)
        where a.user_id = ${userId}
      union select b.user_id from channel_members a join channel_members b using (channel_id)
        join channels c on c.id = a.channel_id where c.kind = 'dm' and a.user_id = ${userId}
    `.execute(this.db);
    return rows.rows.map((row) => row.user_id);
  }

  /**
   * Sends `user.updated` to each person who can see the user. One query finds the audience and
   * the publishes go out as pipelined batches, so a popular user costs a few round trips.
   */
  async announce(userId: string): Promise<void> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!row) return;
    const [summaries, audience] = await Promise.all([
      this.summaries([userId]),
      this.audience(userId),
    ]);
    const payload = JSON.stringify({
      type: 'user.updated',
      user: toDirectoryUser(row),
      profile: summaries[userId] ?? this.summary(undefined, false),
    });
    for (let i = 0; i < audience.length; i += PUBLISH_BATCH) {
      const pipeline = this.redis.pipeline();
      for (const id of audience.slice(i, i + PUBLISH_BATCH))
        pipeline.publish(userTopic(id), payload);
      await pipeline.exec();
    }
  }
}
