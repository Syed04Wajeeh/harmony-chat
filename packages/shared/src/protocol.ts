import { z } from 'zod';
import { InteractionFailureReason, InvokeCommandBody } from './bots.js';
import { Embeds } from './embeds.js';
import { ModuleId } from './modules.js';
import {
  ChannelSummary,
  Channel,
  DirectoryUser,
  Guild,
  GuildSummary,
  Id,
  Me,
  Message,
  PresenceStatus,
  ReadState,
  SendMessageFields,
  hasContentOrAttachments,
  Nonce,
  UserStatus,
} from './chat.js';
import { ChannelOverwrite, Role } from './permissions.js';

export const MAX_FRAME_BYTES = 16 * 1024;
export const BACKFILL_LIMIT = 200;
/** Typing indicators older than this are stale; clients drop them after roughly this long. */
export const TYPING_EXPIRY_MS = 6000;

export const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), channelId: Id, lastSeenId: Id.optional() }),
  z.object({ type: z.literal('unsubscribe'), channelId: Id }),
  z
    .object({ type: z.literal('message.send'), channelId: Id, ...SendMessageFields, nonce: Nonce })
    .refine(hasContentOrAttachments, { message: 'Message is empty', path: ['content'] }),
  z.object({ type: z.literal('read'), channelId: Id, messageId: Id }),
  z.object({ type: z.literal('typing'), channelId: Id }),
  z.object({ type: z.literal('presence.set'), status: UserStatus }),
  z.object({ type: z.literal('command.invoke'), channelId: Id, ...InvokeCommandBody.shape }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

const channelEvents = [
  z.object({ type: z.literal('message.created'), message: Message, nonce: Nonce.optional() }),
  z.object({ type: z.literal('message.updated'), message: Message }),
  z.object({ type: z.literal('message.deleted'), channelId: Id, messageId: Id }),
  z.object({
    type: z.literal('reaction.added'),
    channelId: Id,
    messageId: Id,
    emoji: z.string(),
    userId: Id,
  }),
  z.object({
    type: z.literal('reaction.removed'),
    channelId: Id,
    messageId: Id,
    emoji: z.string(),
    userId: Id,
  }),
  z.object({ type: z.literal('typing'), channelId: Id, userId: Id }),
] as const;

const userEvents = [
  z.object({ type: z.literal('channel.joined'), channel: ChannelSummary }),
  z.object({ type: z.literal('channel.removed'), channelId: Id }),
  z.object({ type: z.literal('channel.updated'), channel: Channel }),
  z.object({ type: z.literal('read.updated'), ...ReadState.shape }),
  z.object({ type: z.literal('mention'), channelId: Id, messageId: Id }),
  z.object({ type: z.literal('guild.joined'), guild: GuildSummary }),
  z.object({ type: z.literal('guild.updated'), guild: Guild }),
  z.object({ type: z.literal('guild.removed'), guildId: Id }),
  z.object({ type: z.literal('guild.member_joined'), guildId: Id, user: DirectoryUser }),
  z.object({ type: z.literal('guild.member_left'), guildId: Id, userId: Id }),
  z.object({ type: z.literal('guild.role_created'), guildId: Id, role: Role }),
  z.object({ type: z.literal('guild.role_updated'), guildId: Id, role: Role }),
  z.object({ type: z.literal('guild.role_deleted'), guildId: Id, roleId: Id }),
  z.object({
    type: z.literal('guild.member_updated'),
    guildId: Id,
    userId: Id,
    roleIds: z.array(Id),
    nickname: z.string().nullable(),
  }),
  z.object({
    type: z.literal('channel.overwrites_updated'),
    channelId: Id,
    overwrites: z.array(ChannelOverwrite),
  }),
  z.object({
    type: z.literal('guild.modules_updated'),
    guildId: Id,
    moduleId: ModuleId,
    enabled: z.boolean(),
    settings: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('interaction.ephemeral'),
    interactionId: Id,
    channelId: Id,
    command: z.string(),
    botId: Id.nullable(),
    source: z.string().optional(),
    content: z.string(),
    embeds: Embeds.optional(),
    nonce: Nonce.optional(),
  }),
  z.object({
    type: z.literal('interaction.pending'),
    interactionId: Id,
    channelId: Id,
    command: z.string(),
    botId: Id.nullable(),
    source: z.string().optional(),
    expiresAt: z.iso.datetime(),
    nonce: Nonce.optional(),
  }),
  z.object({
    type: z.literal('interaction.failed'),
    interactionId: Id,
    channelId: Id,
    command: z.string(),
    botId: Id.nullable(),
    source: z.string().optional(),
    reason: InteractionFailureReason,
    nonce: Nonce.optional(),
  }),
] as const;

const presenceEvent = z.object({
  type: z.literal('presence.updated'),
  userId: Id,
  status: PresenceStatus,
});

/** Published to `harmony:channel:<id>`; delivered to sockets subscribed to that channel. */
export const ChannelEvent = z.discriminatedUnion('type', [...channelEvents]);
export type ChannelEvent = z.infer<typeof ChannelEvent>;

/** Published to `harmony:user:<id>`; delivered to every socket of that user on any instance. */
export const UserEvent = z.discriminatedUnion('type', [...userEvents]);
export type UserEvent = z.infer<typeof UserEvent>;

/** Published to `harmony:presence`; delivered to every connected socket. */
export const PresenceEvent = presenceEvent;
export type PresenceEvent = z.infer<typeof PresenceEvent>;

/**
 * `backfill` doubles as the subscription confirmation: it is always sent once the
 * subscription is live, with an empty list when no `lastSeenId` was given.
 */
export const ServerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), user: Me, instanceId: z.string() }),
  z.object({ type: z.literal('ack'), nonce: Nonce, message: Message }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    nonce: Nonce.optional(),
  }),
  z.object({
    type: z.literal('backfill'),
    channelId: Id,
    messages: z.array(Message),
    hasMore: z.boolean(),
  }),
  presenceEvent,
  ...channelEvents,
  ...userEvents,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

export const CHANNEL_TOPIC_PREFIX = 'harmony:channel:';
export const USER_TOPIC_PREFIX = 'harmony:user:';
export const PRESENCE_TOPIC = 'harmony:presence';

export const channelTopic = (channelId: string): string => `${CHANNEL_TOPIC_PREFIX}${channelId}`;
export const userTopic = (userId: string): string => `${USER_TOPIC_PREFIX}${userId}`;
