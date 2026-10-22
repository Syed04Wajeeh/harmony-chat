import { sql, type Kysely } from 'kysely';
import {
  REACTION_USER_PREVIEW,
  type Attachment,
  type Embed,
  type Message,
  type Reaction,
} from '@harmony/shared';
import type { Database } from '../db/schema.js';

export interface MessageRow {
  id: string;
  channel_id: string;
  content: string;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  pinned_at: Date | null;
  pinned_by: string | null;
  reply_to_id: string | null;
  author_id: string;
  author_login: string;
  author_name: string;
  author_avatar: string | null;
  author_kind: 'human' | 'bot';
  webhook_id: string | null;
  display_name_override: string | null;
  avatar_url_override: string | null;
  embeds: unknown;
  parent_id: string | null;
  parent_author_id: string | null;
  parent_preview: string | null;
  parent_deleted_at: Date | null;
}

export interface Page {
  messages: Message[];
  hasMore: boolean;
}

export const attachmentUrl = (id: string, filename: string): string =>
  `/api/attachments/${id}/${encodeURIComponent(filename)}`;

/**
 * Reads messages in their API shape. Every list goes through `hydrate`, which loads reactions,
 * attachments and mentions for the whole page with one query each, never per message.
 */
export class MessageReader {
  constructor(private readonly db: Kysely<Database>) {}

  query() {
    return this.db
      .selectFrom('messages')
      .innerJoin('users', 'users.id', 'messages.author_id')
      .leftJoin('messages as parent', 'parent.id', 'messages.reply_to_id')
      .select([
        'messages.id',
        'messages.channel_id',
        'messages.content',
        'messages.created_at',
        'messages.edited_at',
        'messages.deleted_at',
        'messages.pinned_at',
        'messages.pinned_by',
        'messages.reply_to_id',
        'users.id as author_id',
        'users.login as author_login',
        'users.display_name as author_name',
        'users.avatar_url as author_avatar',
        'users.kind as author_kind',
        'messages.webhook_id',
        'messages.display_name_override',
        'messages.avatar_url_override',
        'messages.embeds',
        'parent.id as parent_id',
        'parent.author_id as parent_author_id',
        'parent.deleted_at as parent_deleted_at',
      ])
      .select(sql<string | null>`left(parent.content, 100)`.as('parent_preview'));
  }

  async load(ids: string[]): Promise<Message[]> {
    if (ids.length === 0) return [];
    const rows = await this.query().where('messages.id', 'in', ids).execute();
    const order = new Map(ids.map((id, index) => [id, index]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return this.hydrate(rows);
  }

  async loadOne(id: string): Promise<Message> {
    const [message] = await this.load([id]);
    if (!message) throw new Error(`message ${id} vanished`);
    return message;
  }

  /**
   * Loads a message the caller has just created in the same transaction. A new message has no
   * reactions, and the caller already knows its mentions and whether it has attachments, so only
   * the message query runs (plus the attachment query when there are attachments) instead of four.
   */
  async loadCreated(
    id: string,
    known: { mentions: readonly string[]; hasAttachments: boolean },
  ): Promise<Message> {
    const rows = await this.query().where('messages.id', '=', id).execute();
    const mentions = [...known.mentions].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const [message] = await this.hydrate(rows, {
      reactions: new Map(),
      mentions: new Map([[id, mentions]]),
      ...(!known.hasAttachments && { attachments: new Map() }),
    });
    if (!message) throw new Error(`message ${id} vanished`);
    return message;
  }

  /** Turns `limit + 1` rows fetched newest-first into a page, oldest first. */
  async pageDescending(rows: MessageRow[], limit: number): Promise<Page> {
    const hasMore = rows.length > limit;
    const messages = await this.hydrate(rows.slice(0, limit));
    return { messages: messages.reverse(), hasMore };
  }

  /** Turns `limit + 1` rows into a page without reordering them. */
  async pageAsFetched(rows: MessageRow[], limit: number): Promise<Page> {
    return { messages: await this.hydrate(rows.slice(0, limit)), hasMore: rows.length > limit };
  }

  /** `known` supplies side tables the caller already has, so their queries are skipped. */
  async hydrate(
    rows: MessageRow[],
    known: {
      reactions?: Map<string, Reaction[]>;
      attachments?: Map<string, Attachment[]>;
      mentions?: Map<string, string[]>;
    } = {},
  ): Promise<Message[]> {
    const visible = rows.filter((row) => !row.deleted_at).map((row) => row.id);
    const [reactions, attachments, mentions] = await Promise.all([
      known.reactions ?? this.reactions(visible),
      known.attachments ?? this.attachments(visible),
      known.mentions ?? this.mentions(visible),
    ]);
    return rows.map((row) => {
      const deleted = row.deleted_at !== null;
      return {
        id: row.id,
        channelId: row.channel_id,
        author: {
          id: row.author_id,
          login: row.author_login,
          displayName: row.author_name,
          avatarUrl: row.author_avatar,
          ...(row.author_kind === 'bot' && { isBot: true }),
        },
        content: deleted ? '' : row.content,
        createdAt: row.created_at.toISOString(),
        editedAt: row.edited_at?.toISOString() ?? null,
        deleted,
        pinnedAt: deleted ? null : (row.pinned_at?.toISOString() ?? null),
        pinnedBy: deleted ? null : row.pinned_by,
        replyTo:
          deleted || !row.parent_id || !row.parent_author_id
            ? null
            : {
                id: row.parent_id,
                authorId: row.parent_author_id,
                contentPreview: row.parent_deleted_at ? '' : (row.parent_preview ?? ''),
                deleted: row.parent_deleted_at !== null,
              },
        reactions: reactions.get(row.id) ?? [],
        attachments: attachments.get(row.id) ?? [],
        mentions: mentions.get(row.id) ?? [],
        ...(row.webhook_id && { webhookId: row.webhook_id }),
        ...(!deleted &&
          row.display_name_override && { displayNameOverride: row.display_name_override }),
        ...(!deleted && row.avatar_url_override && { avatarUrlOverride: row.avatar_url_override }),
        ...(!deleted &&
          Array.isArray(row.embeds) &&
          row.embeds.length > 0 && { embeds: row.embeds as Embed[] }),
      };
    });
  }

  private async reactions(ids: string[]): Promise<Map<string, Reaction[]>> {
    const grouped = new Map<string, Reaction[]>();
    if (ids.length === 0) return grouped;
    const { rows } = await sql<{
      message_id: string;
      emoji: string;
      count: number;
      user_ids: string[];
    }>`
      select message_id, emoji, count(*)::int as count,
             (array_agg(user_id order by created_at, user_id))[1:${REACTION_USER_PREVIEW}] as user_ids
      from message_reactions
      where message_id = any(${ids}::bigint[])
      group by message_id, emoji
      order by min(created_at), emoji
    `.execute(this.db);
    for (const row of rows) {
      const list = grouped.get(row.message_id) ?? [];
      list.push({ emoji: row.emoji, count: row.count, userIds: row.user_ids });
      grouped.set(row.message_id, list);
    }
    return grouped;
  }

  private async attachments(ids: string[]): Promise<Map<string, Attachment[]>> {
    const grouped = new Map<string, Attachment[]>();
    if (ids.length === 0) return grouped;
    const rows = await this.db
      .selectFrom('attachments')
      .selectAll()
      .where('message_id', 'in', ids)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    for (const row of rows) {
      if (!row.message_id) continue;
      const list = grouped.get(row.message_id) ?? [];
      list.push({
        id: row.id,
        filename: row.filename,
        contentType: row.content_type,
        sizeBytes: Number(row.size_bytes),
        width: row.width,
        height: row.height,
        url: attachmentUrl(row.id, row.filename),
      });
      grouped.set(row.message_id, list);
    }
    return grouped;
  }

  private async mentions(ids: string[]): Promise<Map<string, string[]>> {
    const grouped = new Map<string, string[]>();
    if (ids.length === 0) return grouped;
    const rows = await this.db
      .selectFrom('message_mentions')
      .select(['message_id', 'user_id'])
      .where('message_id', 'in', ids)
      .orderBy('user_id')
      .execute();
    for (const row of rows) {
      const list = grouped.get(row.message_id) ?? [];
      list.push(row.user_id);
      grouped.set(row.message_id, list);
    }
    return grouped;
  }
}
