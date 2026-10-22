import { z } from 'zod';
import { Embed } from './embeds.js';

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_NONCE_LENGTH = 64;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_TOPIC_LENGTH = 256;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
/** Unread and mention counts stop counting here; `100` means "100 or more". */
export const UNREAD_COUNT_CAP = 100;
export const REPLY_PREVIEW_LENGTH = 100;
export const REACTION_USER_PREVIEW = 20;

/** Database ids are bigints; they travel as decimal strings. */
export const Id = z.string().regex(/^\d{1,18}$/, 'Expected a numeric id');
export type Id = z.infer<typeof Id>;

export const User = z.object({
  id: Id,
  login: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  /** True for bots and webhook authors. */
  isBot: z.boolean().optional(),
});
export type User = z.infer<typeof User>;

export const DirectoryUser = User.extend({ isAdmin: z.boolean() });
export type DirectoryUser = z.infer<typeof DirectoryUser>;

/** The status a user chose; `invisible` shows as offline to everyone else. */
export const UserStatus = z.enum(['online', 'idle', 'dnd', 'invisible']);
export type UserStatus = z.infer<typeof UserStatus>;

/** What other users see: `offline` is derived from connections, never chosen. */
export const PresenceStatus = z.enum(['online', 'idle', 'dnd', 'offline']);
export type PresenceStatus = z.infer<typeof PresenceStatus>;

export const Me = DirectoryUser.extend({ status: UserStatus });
export type Me = z.infer<typeof Me>;

export const ChannelKind = z.enum(['text', 'dm']);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const ChannelName = z
  .string()
  .regex(/^[a-z0-9-]{1,32}$/, 'Use 1-32 lowercase letters, digits or hyphens');
export const ChannelTopic = z.string().trim().max(MAX_TOPIC_LENGTH);

export const Channel = z.object({
  id: Id,
  /** Null for DMs, which live outside guilds. */
  guildId: Id.nullable(),
  kind: ChannelKind,
  /** Null for DMs. */
  name: z.string().nullable(),
  topic: z.string().nullable(),
  isPrivate: z.boolean(),
  createdBy: Id.nullable(),
  /** The other participant of a DM, from the requesting user's point of view. */
  dmUser: User.nullable(),
});
export type Channel = z.infer<typeof Channel>;

export const ChannelSummary = Channel.extend({
  unreadCount: z.number().int().min(0).max(UNREAD_COUNT_CAP),
  mentionCount: z.number().int().min(0).max(UNREAD_COUNT_CAP),
  lastMessageId: Id.nullable(),
  lastReadMessageId: Id.nullable(),
});
export type ChannelSummary = z.infer<typeof ChannelSummary>;

export const MessageContent = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);
export const Nonce = z.string().min(1).max(MAX_NONCE_LENGTH);

export const Attachment = z.object({
  id: z.uuid(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Same-origin download path; requires channel membership. */
  url: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;

export const ReplyPreview = z.object({
  id: Id,
  authorId: Id,
  contentPreview: z.string(),
  deleted: z.boolean(),
});
export type ReplyPreview = z.infer<typeof ReplyPreview>;

export const Reaction = z.object({
  emoji: z.string(),
  count: z.number().int(),
  /** The first few reactors, oldest first. */
  userIds: z.array(Id),
});
export type Reaction = z.infer<typeof Reaction>;

export const Message = z.object({
  id: Id,
  channelId: Id,
  author: User,
  /** The author's nickname in the message's guild, when they have one. */
  authorNickname: z.string().nullable().optional(),
  /** Empty for deleted messages. */
  content: z.string(),
  createdAt: z.iso.datetime(),
  editedAt: z.iso.datetime().nullable(),
  deleted: z.boolean(),
  pinnedAt: z.iso.datetime().nullable(),
  pinnedBy: Id.nullable(),
  replyTo: ReplyPreview.nullable(),
  reactions: z.array(Reaction),
  attachments: z.array(Attachment),
  /** Users mentioned with `<@id>` who were members of the channel when sent or edited. */
  mentions: z.array(Id),
  embeds: z.array(Embed).optional(),
  /** Set when the message was posted by an incoming webhook. */
  webhookId: Id.nullable().optional(),
  /** Per-message name and avatar given by a webhook caller; clients show them in place of the author's. */
  displayNameOverride: z.string().nullable().optional(),
  avatarUrlOverride: z.string().nullable().optional(),
  /** Data attached by modules, keyed by module id. Clients validate each entry themselves. */
  modules: z.record(z.string(), z.unknown()).optional(),
});
export type Message = z.infer<typeof Message>;

export const ErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const ChannelParams = z.object({ id: Id });
export const MessageParams = z.object({ id: Id });
export const ChannelMemberParams = z.object({ id: Id, userId: Id });
export const ReactionParams = z.object({ id: Id, emoji: z.string().min(1).max(100) });
export const AttachmentParams = z.object({ id: z.uuid(), filename: z.string().max(255) });

export const ListChannelsResponse = z.object({ channels: z.array(ChannelSummary) });
export type ListChannelsResponse = z.infer<typeof ListChannelsResponse>;

export const CreateChannelBody = z.object({
  name: ChannelName,
  topic: ChannelTopic.optional(),
  /** Private channels are visible only to the members added to them. */
  isPrivate: z.boolean().default(false),
});
export type CreateChannelBody = z.input<typeof CreateChannelBody>;

export const MAX_GUILD_NAME_LENGTH = 100;
export const GuildName = z.string().trim().min(1).max(MAX_GUILD_NAME_LENGTH);

export const Guild = z.object({
  id: Id,
  name: z.string(),
  iconUrl: z.string().nullable(),
  ownerId: Id,
  memberCount: z.number().int(),
});
export type Guild = z.infer<typeof Guild>;

/** Counts add up the guild's channels for this user and stop at 100, like per-channel counts. */
export const GuildSummary = Guild.extend({
  unreadCount: z.number().int().min(0).max(UNREAD_COUNT_CAP),
  mentionCount: z.number().int().min(0).max(UNREAD_COUNT_CAP),
});
export type GuildSummary = z.infer<typeof GuildSummary>;

export const GuildParams = z.object({ id: Id });
export const ListGuildsResponse = z.object({ guilds: z.array(GuildSummary) });
export const CreateGuildBody = z.object({ name: GuildName });
export const UpdateGuildBody = z
  .object({
    name: GuildName.optional(),
    /** An image the caller uploaded with POST /api/uploads; null removes the icon. */
    iconAttachmentId: z.uuid().nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateGuildBody = z.infer<typeof UpdateGuildBody>;

export const ListDmsResponse = ListChannelsResponse;

export const Invite = z.object({
  code: z.string(),
  guildId: Id,
  createdBy: Id,
  expiresAt: z.iso.datetime().nullable(),
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type Invite = z.infer<typeof Invite>;

export const CreateInviteBody = z.object({
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresInSeconds: z
    .number()
    .int()
    .min(60)
    .max(30 * 24 * 60 * 60)
    .optional(),
});
export const InviteParams = z.object({ code: z.string().min(1).max(64) });
export const InvitePreview = z.object({
  code: z.string(),
  guild: z.object({ id: Id, name: z.string(), iconUrl: z.string().nullable() }),
  memberCount: z.number().int(),
  alreadyMember: z.boolean(),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

export const UpdateChannelBody = z
  .object({
    name: ChannelName.optional(),
    topic: ChannelTopic.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateChannelBody = z.infer<typeof UpdateChannelBody>;

export const AddMemberBody = z.object({ userId: Id });
export const MembersResponse = z.object({ members: z.array(DirectoryUser) });
export type MembersResponse = z.infer<typeof MembersResponse>;

export const MarkReadBody = z.object({ messageId: Id });
export const ReadState = z.object({
  channelId: Id,
  lastReadMessageId: Id,
  unreadCount: z.number().int().min(0).max(UNREAD_COUNT_CAP),
  mentionCount: z.number().int().min(0).max(UNREAD_COUNT_CAP),
});
export type ReadState = z.infer<typeof ReadState>;

export const ListMessagesQuery = z.object({
  before: Id.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;

export const ListMessagesResponse = z.object({
  messages: z.array(Message),
  hasMore: z.boolean(),
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>;

export const PinsResponse = z.object({ messages: z.array(Message) });

/** Content may be empty only when attachments are present. */
export const hasContentOrAttachments = (body: {
  content: string;
  attachmentIds?: readonly string[] | undefined;
}): boolean => body.content.length > 0 || (body.attachmentIds?.length ?? 0) > 0;

export const SendMessageFields = {
  content: z.string().trim().max(MAX_MESSAGE_LENGTH),
  replyToId: Id.optional(),
  attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
};

export const SendMessageBody = z
  .object({ ...SendMessageFields, nonce: Nonce.optional() })
  .refine(hasContentOrAttachments, { message: 'Message is empty', path: ['content'] });
export type SendMessageBody = z.infer<typeof SendMessageBody>;

export const EditMessageBody = z.object({ content: MessageContent });

export const UpdateMeBody = z.object({ status: UserStatus });

export const ListUsersResponse = z.object({ users: z.array(DirectoryUser) });
export type ListUsersResponse = z.infer<typeof ListUsersResponse>;

export const CreateDmBody = z.object({ userId: Id });

export const PresenceEntry = z.object({ userId: Id, status: PresenceStatus });
export type PresenceEntry = z.infer<typeof PresenceEntry>;
export const PresenceResponse = z.object({
  /** Users that are online, idle or dnd. Everyone else is offline. */
  presence: z.array(PresenceEntry),
});
export type PresenceResponse = z.infer<typeof PresenceResponse>;

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  channelId: Id.optional(),
  before: Id.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const UploadResponse = Attachment;
