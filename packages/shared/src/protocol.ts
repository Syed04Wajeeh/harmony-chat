import { z } from 'zod';
import { Id, Message, MessageContent, Nonce, User } from './chat.js';

export const MAX_FRAME_BYTES = 16 * 1024;
export const BACKFILL_LIMIT = 200;

export const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), channelId: Id, lastSeenId: Id.optional() }),
  z.object({ type: z.literal('unsubscribe'), channelId: Id }),
  z.object({
    type: z.literal('message.send'),
    channelId: Id,
    content: MessageContent,
    nonce: Nonce,
  }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/**
 * `backfill` doubles as the subscription confirmation: it is always sent once the
 * subscription is live, with an empty list when no `lastSeenId` was given.
 */
export const ServerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), user: User, instanceId: z.string() }),
  z.object({ type: z.literal('message.created'), message: Message, nonce: Nonce.optional() }),
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
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

export const MESSAGE_CHANNEL_PREFIX = 'harmony:channel:';

/** What the server publishes to Redis for every persisted message. */
export const MessageEnvelope = z.object({
  type: z.literal('message.created'),
  message: Message,
  nonce: Nonce.nullable(),
  originInstance: z.string(),
});
export type MessageEnvelope = z.infer<typeof MessageEnvelope>;
