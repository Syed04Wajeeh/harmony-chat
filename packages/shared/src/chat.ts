import { z } from 'zod';

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_NONCE_LENGTH = 64;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** Database ids are bigints; they travel as decimal strings. */
export const Id = z.string().regex(/^\d{1,18}$/, 'Expected a numeric id');
export type Id = z.infer<typeof Id>;

export const User = z.object({
  id: Id,
  login: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});
export type User = z.infer<typeof User>;

export const Channel = z.object({
  id: Id,
  name: z.string(),
  topic: z.string().nullable(),
});
export type Channel = z.infer<typeof Channel>;

export const MessageContent = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);
export const Nonce = z.string().min(1).max(MAX_NONCE_LENGTH);

export const Message = z.object({
  id: Id,
  channelId: Id,
  author: User,
  content: z.string(),
  createdAt: z.iso.datetime(),
  editedAt: z.iso.datetime().nullable(),
});
export type Message = z.infer<typeof Message>;

export const ErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const ChannelParams = z.object({ id: Id });

export const ListChannelsResponse = z.object({ channels: z.array(Channel) });
export type ListChannelsResponse = z.infer<typeof ListChannelsResponse>;

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

export const SendMessageBody = z.object({
  content: MessageContent,
  nonce: Nonce.optional(),
});
export type SendMessageBody = z.infer<typeof SendMessageBody>;
