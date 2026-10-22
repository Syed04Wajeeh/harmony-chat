import type { Kysely, Transaction } from 'kysely';
import {
  parseMentions,
  type DirectoryUser,
  type Embed,
  type EventType,
  type Message,
} from '@harmony/shared';
import type { ChannelService } from '../channels/service.js';
import type { Database } from '../db/schema.js';
import { enqueueEvent } from '../events/outbox.js';
import { AppError } from '../errors.js';
import type { DomainEvents } from '../modules/domain-events.js';
import type { MessageTarget } from '../modules/types.js';
import type { PermissionService } from '../permissions/service.js';
import type { RateLimiter } from '../rate-limit.js';
import type { EventBus } from '../realtime/events.js';
import type { MessageDecorators } from './decorators.js';
import { MessageReader, type Page } from './reader.js';

export type { Page };

export interface SendMessageInput {
  author: DirectoryUser;
  channelId: string;
  content: string;
  nonce?: string | undefined;
  replyToId?: string | undefined;
  attachmentIds?: readonly string[] | undefined;
  embeds?: readonly Embed[] | undefined;
  /** Set for incoming-webhook messages: per-message overrides, no membership or user limit. */
  source?: { webhookId: string; displayName?: string | undefined; avatarUrl?: string | undefined };
  /**
   * Set by a module that attaches data to the message: the message is marked with the module's
   * id, and `setup` writes the module's own rows in the same transaction.
   */
  module?: {
    id: string;
    setup(trx: Transaction<Database>, messageId: string): Promise<void>;
  };
}

type Actor = Pick<DirectoryUser, 'id' | 'isAdmin'>;

export class MessageService {
  readonly reader: MessageReader;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly events: EventBus,
    private readonly channels: ChannelService,
    private readonly sendLimiter: RateLimiter,
    private readonly domain: DomainEvents,
    private readonly decorators: MessageDecorators,
    private readonly perms: PermissionService,
  ) {
    this.reader = new MessageReader(db, (authors) => perms.nicknames(authors), decorators);
  }

  /**
   * The only write path for new messages: REST, WebSocket, webhooks and bot replies all land
   * here. A webhook message skips the membership check and the per-user limit because the caller
   * already authenticated with the webhook's own token and limiter.
   */
  async send(input: SendMessageInput): Promise<Message> {
    const { author, channelId, content, nonce, replyToId, source } = input;
    let channel;
    if (source) {
      channel = await this.db
        .selectFrom('channels')
        .selectAll()
        .where('id', '=', channelId)
        .executeTakeFirst();
      if (!channel) throw new AppError(404, 'channel_not_found', 'Channel not found');
    } else {
      if (!(await this.sendLimiter.consume(author.id))) {
        throw new AppError(429, 'rate_limited', 'You are sending messages too quickly');
      }
      channel = await this.channels.requireMember(channelId, author.id);
      if (channel.guild_id) {
        await this.perms.require(author, channel.guild_id, 'send_messages', channelId);
        if (input.attachmentIds?.length) {
          await this.perms.require(author, channel.guild_id, 'attach_files', channelId);
        }
      }
    }
    if (channel.archived_at) throw new AppError(409, 'channel_archived', 'Channel is archived');

    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    await this.perms.warm(channelId);
    const { message, notify } = await this.db.transaction().execute(async (trx) => {
      if (replyToId) {
        const parent = await trx
          .selectFrom('messages')
          .select('id')
          .where('id', '=', replyToId)
          .where('channel_id', '=', channelId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!parent) throw new AppError(400, 'invalid_reply', 'Cannot reply to that message');
      }
      if (attachmentIds.length > 0) {
        const owned = await trx
          .selectFrom('attachments')
          .select('id')
          .where('id', 'in', attachmentIds)
          .where('uploader_id', '=', author.id)
          .where('message_id', 'is', null)
          .forUpdate()
          .execute();
        if (owned.length !== attachmentIds.length) {
          throw new AppError(
            400,
            'invalid_attachments',
            'Attachments must be your own uploads and not already attached',
          );
        }
      }

      const row = await trx
        .insertInto('messages')
        .values({
          channel_id: channelId,
          author_id: author.id,
          content,
          reply_to_id: replyToId ?? null,
          edited_at: null,
          deleted_at: null,
          pinned_at: null,
          pinned_by: null,
          ...(input.embeds?.length && { embeds: JSON.stringify(input.embeds) }),
          ...(input.module && { modules: [input.module.id] }),
          ...(source && {
            webhook_id: source.webhookId,
            display_name_override: source.displayName ?? null,
            avatar_url_override: source.avatarUrl ?? null,
          }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (attachmentIds.length > 0) {
        await trx
          .updateTable('attachments')
          .set({ message_id: row.id })
          .where('id', 'in', attachmentIds)
          .execute();
      }
      // A new message has no mention rows yet, so nothing to delete, and what was inserted is
      // exactly what the loaded message will carry.
      const notify = await this.syncMentions(trx, row.id, channelId, author.id, content, true);
      await input.module?.setup(trx, row.id);
      const message = await this.inTransaction(trx).loadCreated(row.id, {
        mentions: notify,
        hasAttachments: attachmentIds.length > 0,
      });
      await this.emit(trx, channel.guild_id, channelId, 'message.created', { message });
      return { message, notify };
    });

    await this.events.toChannel(channelId, {
      type: 'message.created',
      message,
      ...(nonce && { nonce }),
    });
    await this.notifyMentions(channelId, message.id, notify);
    this.domain.emit('message.created', { guildId: channel.guild_id, channelId, message });
    return message;
  }

  /** A reader for use inside a transaction: it must not wait on the pool, so nicknames are cache-only. */
  private inTransaction(trx: Transaction<Database>): MessageReader {
    return new MessageReader(
      trx,
      (authors) => this.perms.cachedNicknames(authors),
      this.decorators,
    );
  }

  async edit(actor: Actor, messageId: string, content: string): Promise<Message> {
    const target = await this.find(messageId, actor.id);
    if (!target.isMember) throw forbidden();
    if (target.deleted_at) throw notFound();
    if (target.author_id !== actor.id) {
      throw new AppError(403, 'forbidden', 'Only the author can edit a message');
    }

    await this.perms.warm(target.channel_id);
    const { message, notify } = await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('messages')
        .set({ content, edited_at: new Date() })
        .where('id', '=', messageId)
        .execute();
      const notify = await this.syncMentions(trx, messageId, target.channel_id, actor.id, content);
      const message = await this.inTransaction(trx).loadOne(messageId);
      await this.emit(trx, target.guild_id, target.channel_id, 'message.updated', { message });
      return { message, notify };
    });
    await this.events.toChannel(target.channel_id, { type: 'message.updated', message });
    await this.notifyMentions(target.channel_id, messageId, notify);
    this.domain.emit('message.updated', {
      guildId: target.guild_id,
      channelId: target.channel_id,
      message,
    });
    return message;
  }

  /** Soft delete: the row stays (replies, audit) but is served as an empty tombstone. */
  async delete(actor: Actor, messageId: string): Promise<void> {
    const target = await this.find(messageId, actor.id);
    if (target.author_id !== actor.id) {
      // A DM has no guild and so no roles; there only the instance admin override applies.
      if (target.guild_id) {
        await this.perms.require(actor, target.guild_id, 'manage_messages', target.channel_id);
      } else if (!actor.isAdmin) {
        throw new AppError(403, 'forbidden', 'Only the author can delete a message');
      }
    }
    const deleted = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('messages')
        .set({ deleted_at: new Date() })
        .where('id', '=', messageId)
        .where('deleted_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (row) {
        await this.emit(trx, target.guild_id, target.channel_id, 'message.deleted', {
          channelId: target.channel_id,
          messageId,
        });
      }
      return row !== undefined;
    });
    if (!deleted) return;
    await this.events.toChannel(target.channel_id, {
      type: 'message.deleted',
      channelId: target.channel_id,
      messageId,
    });
    this.domain.emit('message.deleted', {
      guildId: target.guild_id,
      channelId: target.channel_id,
      messageId,
    });
  }

  /**
   * For modules that keep their own state in a message's columns (pins): runs `change` in a
   * transaction, and if it reports a change, announces the message as updated everywhere
   * (outbox, realtime, in-process event). Returns the message either way.
   */
  async update(
    target: Pick<MessageTarget, 'id' | 'channel_id' | 'guild_id'>,
    change: (trx: Transaction<Database>) => Promise<boolean>,
  ): Promise<{ changed: boolean; message: Message }> {
    await this.perms.warm(target.channel_id);
    const { changed, message } = await this.db.transaction().execute(async (trx) => {
      const changed = await change(trx);
      const message = await this.inTransaction(trx).loadOne(target.id);
      if (changed) {
        await this.emit(trx, target.guild_id, target.channel_id, 'message.updated', { message });
      }
      return { changed, message };
    });
    if (changed) {
      await this.events.toChannel(target.channel_id, { type: 'message.updated', message });
      this.domain.emit('message.updated', {
        guildId: target.guild_id,
        channelId: target.channel_id,
        message,
      });
    }
    return { changed, message };
  }

  /** Keyset pagination: newest `limit` messages older than `before`, returned oldest first. */
  async history(channelId: string, limit: number, before?: string): Promise<Page> {
    let query = this.reader
      .query()
      .where('messages.channel_id', '=', channelId)
      .orderBy('messages.id', 'desc')
      .limit(limit + 1);
    if (before) query = query.where('messages.id', '<', before);
    return this.reader.pageDescending(await query.execute(), limit);
  }

  /** Messages newer than `afterId`, oldest first; used to backfill after a reconnect. */
  async since(channelId: string, afterId: string, limit: number): Promise<Page> {
    const rows = await this.reader
      .query()
      .where('messages.channel_id', '=', channelId)
      .where('messages.id', '>', afterId)
      .orderBy('messages.id', 'asc')
      .limit(limit + 1)
      .execute();
    return this.reader.pageAsFetched(rows, limit);
  }

  /** The message with the caller's membership of its channel; 404 if it does not exist. */
  async find(messageId: string, userId: string): Promise<MessageTarget> {
    const row = await this.db
      .selectFrom('messages')
      .select(['id', 'channel_id', 'author_id', 'deleted_at'])
      .select((eb) =>
        eb
          .selectFrom('channels')
          .select('channels.guild_id')
          .whereRef('channels.id', '=', 'messages.channel_id')
          .as('guild_id'),
      )
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('channel_members')
              .select('user_id')
              .whereRef('channel_members.channel_id', '=', 'messages.channel_id')
              .where('channel_members.user_id', '=', userId),
          )
          .as('is_member'),
      )
      .where('id', '=', messageId)
      .executeTakeFirst();
    if (!row) throw notFound();
    return { ...row, isMember: Boolean(row.is_member) };
  }

  /**
   * Makes message_mentions match the `<@id>` tokens in the content, keeping only channel
   * members other than the author. Returns the users mentioned for the first time.
   */
  private async syncMentions(
    trx: Transaction<Database>,
    messageId: string,
    channelId: string,
    authorId: string,
    content: string,
    isNew = false,
  ): Promise<string[]> {
    const candidates = parseMentions(content).filter((id) => id !== authorId);
    const valid =
      candidates.length === 0
        ? []
        : (
            await trx
              .selectFrom('channel_members')
              .select('user_id')
              .where('channel_id', '=', channelId)
              .where('user_id', 'in', candidates)
              .execute()
          ).map((row) => row.user_id);

    if (!isNew) {
      await trx
        .deleteFrom('message_mentions')
        .where('message_id', '=', messageId)
        .$if(valid.length > 0, (qb) => qb.where('user_id', 'not in', valid))
        .execute();
    }
    if (valid.length === 0) return [];
    const inserted = await trx
      .insertInto('message_mentions')
      .values(valid.map((userId) => ({ message_id: messageId, user_id: userId })))
      .onConflict((oc) => oc.doNothing())
      .returning('user_id')
      .execute();
    return inserted.map((row) => row.user_id);
  }

  /** Writes the event to the outbox in the caller's transaction; DMs have no guild and no events. */
  private async emit(
    trx: Transaction<Database>,
    guildId: string | null,
    channelId: string,
    type: EventType,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (guildId) await enqueueEvent(trx, { guildId, channelId, type, data });
  }

  private async notifyMentions(channelId: string, messageId: string, userIds: string[]) {
    await Promise.all(
      userIds.map((userId) =>
        this.events.toUser(userId, { type: 'mention', channelId, messageId }),
      ),
    );
  }
}

export const notFound = () => new AppError(404, 'message_not_found', 'Message not found');
export const forbidden = () =>
  new AppError(403, 'forbidden', 'You are not a member of this channel');
