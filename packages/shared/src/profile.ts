import { z } from 'zod';
import { DirectoryUser, Id, PresenceEntry } from './chat.js';
import { isValidEmoji } from './emoji.js';

export const MAX_BIO_LENGTH = 190;
export const MAX_PRONOUNS_LENGTH = 40;
export const MAX_STATUS_TEXT_LENGTH = 128;
export const MAX_THEMES_WITH_PERK = 100;

export const PERKS = [
  'animated_avatar',
  'profile_banner_image',
  'cross_server_emoji',
  'larger_uploads',
  'extra_themes',
  'custom_status_emoji',
] as const;
export const Perk = z.enum(PERKS);
export type Perk = z.infer<typeof Perk>;

export const PERK_LABELS: Record<Perk, { name: string; description: string }> = {
  animated_avatar: { name: 'Animated avatar', description: 'Use a GIF or animated WebP avatar.' },
  profile_banner_image: {
    name: 'Banner image',
    description: 'Use an image as your profile banner instead of a color.',
  },
  cross_server_emoji: {
    name: 'Cross-server emoji',
    description: 'Use custom emoji from other servers you are in.',
  },
  larger_uploads: { name: 'Larger uploads', description: 'Upload bigger files.' },
  extra_themes: { name: 'More themes', description: 'Keep up to 100 custom themes.' },
  custom_status_emoji: {
    name: 'Status emoji',
    description: 'Use custom emoji in your status.',
  },
};

/** Resolves the `PERKS_DEFAULT` setting: a comma list, `all` or `none`. */
export function parsePerkList(value: string): Perk[] {
  const items = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (items.includes('all')) return [...PERKS];
  return items.filter((item): item is Perk => (PERKS as readonly string[]).includes(item));
}

export const STATUS_DURATIONS = ['30m', '1h', '4h', 'today', 'never'] as const;
export const StatusDuration = z.enum(STATUS_DURATIONS);
export type StatusDuration = z.infer<typeof StatusDuration>;

/** When a status set at `now` ends; `today` means the end of the local day (`tzOffsetMinutes`). */
export function statusExpiry(
  duration: StatusDuration,
  now: Date,
  tzOffsetMinutes = 0,
): Date | null {
  const minute = 60_000;
  switch (duration) {
    case 'never':
      return null;
    case '30m':
      return new Date(now.getTime() + 30 * minute);
    case '1h':
      return new Date(now.getTime() + 60 * minute);
    case '4h':
      return new Date(now.getTime() + 240 * minute);
    case 'today': {
      const local = new Date(now.getTime() - tzOffsetMinutes * minute);
      local.setUTCHours(23, 59, 59, 999);
      return new Date(local.getTime() + tzOffsetMinutes * minute);
    }
  }
}

export function isStatusExpired(expiresAt: string | Date | null, now = new Date()): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime();
}

const Color = z.number().int().min(0).max(0xffffff);
const StatusEmoji = z.string().max(64).refine(isValidEmoji, 'Not a valid emoji');

/** The part of a profile that rides along with user lists and `user.updated`. */
export const ProfileSummary = z.object({
  accentColor: Color.nullable(),
  statusEmoji: z.string().nullable(),
  statusText: z.string().nullable(),
  statusExpiresAt: z.iso.datetime().nullable(),
  hasPerks: z.boolean(),
});
export type ProfileSummary = z.infer<typeof ProfileSummary>;

export const Profile = ProfileSummary.extend({
  userId: Id,
  avatarUrl: z.string().nullable(),
  /** The Tailscale picture, shown when no avatar is uploaded. */
  providerAvatarUrl: z.string().nullable(),
  avatarOverridden: z.boolean(),
  bannerUrl: z.string().nullable(),
  bannerColor: Color.nullable(),
  bio: z.string().nullable(),
  pronouns: z.string().nullable(),
  perks: z.array(Perk),
});
export type Profile = z.infer<typeof Profile>;

export const UserProfileResponse = z.object({
  profile: Profile,
  displayName: z.string(),
  login: z.string(),
  createdAt: z.iso.datetime(),
  /** Present when the viewer and the user share the guild asked for. */
  member: z
    .object({
      nickname: z.string().nullable(),
      joinedAt: z.iso.datetime(),
      roleIds: z.array(Id),
    })
    .nullable(),
});
export type UserProfileResponse = z.infer<typeof UserProfileResponse>;

export const UpdateProfileBody = z
  .object({
    avatarAttachmentId: z.uuid().nullable(),
    bannerAttachmentId: z.uuid().nullable(),
    bannerColor: Color.nullable(),
    accentColor: Color.nullable(),
    bio: z.string().trim().max(MAX_BIO_LENGTH).nullable(),
    pronouns: z.string().trim().max(MAX_PRONOUNS_LENGTH).nullable(),
    status: z
      .object({
        emoji: StatusEmoji.nullable().optional(),
        text: z.string().trim().max(MAX_STATUS_TEXT_LENGTH).nullable().optional(),
        duration: StatusDuration,
        tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
      })
      .nullable(),
  })
  .partial();
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

export const ProfileQuery = z.object({ guildId: Id.optional() });

export const PerkGrant = z.object({
  perk: Perk,
  grantedBy: Id.nullable(),
  grantedByName: z.string().nullable(),
  grantedAt: z.iso.datetime(),
});
export const PerkUser = z.object({
  id: Id,
  login: z.string(),
  displayName: z.string(),
  grants: z.array(PerkGrant),
});
export const PerksOverview = z.object({
  defaults: z.array(Perk),
  all: z.array(Perk),
  users: z.array(PerkUser),
});
export type PerksOverview = z.infer<typeof PerksOverview>;
export const GrantPerkBody = z.object({ perk: Perk });
export const PerkParams = z.object({ userId: Id, perk: Perk });
export const MyPerksResponse = z.object({ perks: z.array(Perk), explicit: z.array(Perk) });
export type MyPerksResponse = z.infer<typeof MyPerksResponse>;

export const EMOJI_NAME = /^[a-z0-9_]{2,32}$/;
export const MAX_EMOJI_BYTES = 256 * 1024;
export const MAX_EMOJI_DIMENSION = 128;

export const GuildEmoji = z.object({
  id: Id,
  guildId: Id,
  name: z.string(),
  animated: z.boolean(),
  url: z.string(),
  createdBy: Id.nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type GuildEmoji = z.infer<typeof GuildEmoji>;
export const CreateEmojiBody = z.object({
  name: z.string().regex(EMOJI_NAME, 'Use 2-32 lowercase letters, digits or underscores'),
  attachmentId: z.uuid(),
});
export const RenameEmojiBody = z.object({ name: z.string().regex(EMOJI_NAME) });
export const EmojiParams = z.object({ id: Id, emojiId: Id });
export const EmojiImageParams = z.object({ emojiId: Id, filename: z.string().max(255) });
export const ListEmojiResponse = z.object({ emoji: z.array(GuildEmoji) });
/** Emoji of every guild the viewer is in; `usable` reflects the viewer's perks. */
export const MyEmojiResponse = z.object({
  emoji: z.array(GuildEmoji.extend({ usable: z.boolean() })),
});
export type MyEmojiResponse = z.infer<typeof MyEmojiResponse>;

export const ListUsersResponse = z.object({
  users: z.array(DirectoryUser),
  /** Profile summaries for users that have something set, by user id. */
  profiles: z.record(Id, ProfileSummary),
});
export type ListUsersResponse = z.infer<typeof ListUsersResponse>;

export const DIRECTORY_PAGE_MAX = 100;
export const DirectoryQuery = z.object({
  /** Matches display name or login, case-insensitively. */
  q: z.string().trim().max(100).optional(),
  kind: z.enum(['human', 'bot']).default('human'),
  limit: z.coerce.number().int().min(1).max(DIRECTORY_PAGE_MAX).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type DirectoryQuery = z.infer<typeof DirectoryQuery>;
export const DirectoryResponse = z.object({
  users: z.array(DirectoryUser),
  profiles: z.record(Id, ProfileSummary),
  /** Online, idle and dnd users among `users`, whether or not you share a guild with them. */
  presence: z.array(PresenceEntry),
  /** Everyone matching, not just this page. */
  total: z.number().int(),
});
export type DirectoryResponse = z.infer<typeof DirectoryResponse>;
