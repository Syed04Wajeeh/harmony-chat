import type { Kysely, Selectable } from 'kysely';
import type { Redis } from 'ioredis';
import {
  MESSAGE_CHANNEL_PREFIX,
  type Message,
  type MessageEnvelope,
  type User,
} from '@harmony/shared';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { MessageRateLimiter } from './rate-limiter.js';

interface MessageRow {
  id: string;
  channel_id: string;
  content: string;
  created_at: Date;
  edited_at: Date | null;
  author_id: string;
  author_login: string;
  author_name: string;
  author_avatar: string | null;
}

export interface SendMessageInput {
  author: User;
  channelId: string;
  content: string;
  nonce?: string | undefined;
}

export interface Page {
  messages: Message[];
  hasMore: boolean;
}

export const redisChannelFor = (channelId: string): string =>
  `${MESSAGE_CHANNEL_PREFIX}${channelId}`;

export class MessageService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    private readonly limiter: MessageRateLimiter,
    private readonly instanceId: string,
  ) {}

  /** The only write path: REST and WebSocket both land here. Delivery happens via Redis. */
  async send({ author, channelId, content, nonce }: SendMessageInput): Promise<Message> {
    if (!(await this.limiter.consume(author.id))) {
      throw new AppError(429, 'rate_limited', 'You are sending messages too quickly');
    }

    let row: Selectable<Database['messages']>;
    try {
      row = await this.db
        .insertInto('messages')
        .values({
          channel_id: channelId,
          author_id: author.id,
          content,
          edited_at: null,
          deleted_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw new AppError(404, 'channel_not_found', 'Channel not found');
      }
      throw error;
    }

    const message: Message = {
      id: row.id,
      channelId: row.channel_id,
      author,
      content: row.content,
      createdAt: row.created_at.toISOString(),
      editedAt: null,
    };
    const envelope: MessageEnvelope = {
      type: 'message.created',
      message,
      nonce: nonce ?? null,
      originInstance: this.instanceId,
    };
    await this.redis.publish(redisChannelFor(channelId), JSON.stringify(envelope));
    return message;
  }

  /** Keyset pagination: newest `limit` messages older than `before`, returned oldest first. */
  async history(channelId: string, limit: number, before?: string): Promise<Page> {
    let query = this.baseQuery(channelId)
      .orderBy('messages.id', 'desc')
      .limit(limit + 1);
    if (before) query = query.where('messages.id', '<', before);
    return toPage(await query.execute(), limit, 'desc');
  }

  /** Messages newer than `afterId`, oldest first; used to backfill after a reconnect. */
  async since(channelId: string, afterId: string, limit: number): Promise<Page> {
    const rows = await this.baseQuery(channelId)
      .where('messages.id', '>', afterId)
      .orderBy('messages.id', 'asc')
      .limit(limit + 1)
      .execute();
    return toPage(rows, limit, 'asc');
  }

  private baseQuery(channelId: string) {
    return this.db
      .selectFrom('messages')
      .innerJoin('users', 'users.id', 'messages.author_id')
      .select([
        'messages.id',
        'messages.channel_id',
        'messages.content',
        'messages.created_at',
        'messages.edited_at',
        'users.id as author_id',
        'users.login as author_login',
        'users.display_name as author_name',
        'users.avatar_url as author_avatar',
      ])
      .where('messages.channel_id', '=', channelId)
      .where('messages.deleted_at', 'is', null);
  }
}

function toPage(rows: MessageRow[], limit: number, order: 'asc' | 'desc'): Page {
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).map(toMessage);
  return { messages: order === 'desc' ? messages.reverse() : messages, hasMore };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    author: {
      id: row.author_id,
      login: row.author_login,
      displayName: row.author_name,
      avatarUrl: row.author_avatar,
    },
    content: row.content,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
  };
}
