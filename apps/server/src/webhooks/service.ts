import type { Kysely } from 'kysely';
import {
  stripMassMentions,
  type CreateWebhookBody,
  type DirectoryUser,
  type Message,
  type Webhook,
  type WebhookExecuteBody,
} from '@harmony/shared';
import { createBotUser } from '../bots/users.js';
import { generateSecret, hashSecret, verifySecret } from '../bots/token.js';
import type { ChannelService } from '../channels/service.js';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import { attachmentUrl } from '../messages/reader.js';
import type { MessageService } from '../messages/service.js';
import type { PermissionService } from '../permissions/service.js';
import type { RateLimiter } from '../rate-limit.js';

type Actor = Pick<DirectoryUser, 'id' | 'isAdmin'>;

const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const DUMMY_HASH = Buffer.alloc(32);

export const webhookPath = (id: string, token: string): string => `/api/webhooks/${id}/${token}`;

export class WebhookService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly channels: ChannelService,
    private readonly messages: MessageService,
    private readonly limiter: RateLimiter,
    private readonly perms: PermissionService,
  ) {}

  /** Webhooks need manage_guild; the creator must be able to see the channel. */
  async create(
    actor: Actor,
    channelId: string,
    body: CreateWebhookBody,
  ): Promise<Webhook & { url: string }> {
    await this.requireManagedChannel(actor, channelId);
    let avatarUrl: string | null = null;
    if (body.avatarAttachmentId) {
      const avatar = await this.db
        .selectFrom('attachments')
        .select(['id', 'filename'])
        .where('id', '=', body.avatarAttachmentId)
        .where('uploader_id', '=', actor.id)
        .where('message_id', 'is', null)
        .where('content_type', 'in', RASTER_TYPES)
        .executeTakeFirst();
      if (!avatar) {
        throw new AppError(400, 'invalid_avatar', 'The avatar must be an image you uploaded');
      }
      avatarUrl = attachmentUrl(avatar.id, avatar.filename);
    }

    const token = generateSecret();
    const id = await this.db.transaction().execute(async (trx) => {
      const userId = await createBotUser(trx, {
        prefix: 'webhook',
        name: body.name,
        avatarUrl,
        ownerId: null,
      });
      const row = await trx
        .insertInto('webhooks')
        .values({
          channel_id: channelId,
          name: body.name,
          avatar_attachment_id: body.avatarAttachmentId ?? null,
          token_hash: hashSecret(token),
          user_id: userId,
          created_by: actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    const [webhook] = await this.fetch(channelId, id);
    if (!webhook) throw new Error('webhook vanished');
    return { ...webhook, url: webhookPath(id, token) };
  }

  async list(actor: Actor, channelId: string): Promise<Webhook[]> {
    await this.requireManagedChannel(actor, channelId);
    return this.fetch(channelId);
  }

  async delete(actor: Actor, webhookId: string): Promise<void> {
    const row = await this.db
      .selectFrom('webhooks')
      .select('channel_id')
      .where('id', '=', webhookId)
      .executeTakeFirst();
    if (!row) throw new AppError(404, 'webhook_not_found', 'Webhook not found');
    await this.requireManagedChannel(actor, row.channel_id);
    await this.db.deleteFrom('webhooks').where('id', '=', webhookId).execute();
  }

  /** Posts a message through the single send path as the webhook's own author. */
  async execute(webhookId: string, token: string, body: WebhookExecuteBody): Promise<Message> {
    const row = await this.db
      .selectFrom('webhooks')
      .innerJoin('users', 'users.id', 'webhooks.user_id')
      .select([
        'webhooks.id',
        'webhooks.channel_id',
        'webhooks.token_hash',
        'users.id as user_id',
        'users.login',
        'users.display_name',
        'users.avatar_url',
      ])
      .where('webhooks.id', '=', webhookId)
      .executeTakeFirst();
    const valid = verifySecret(token, row?.token_hash ?? DUMMY_HASH);
    if (!row || !valid) throw new AppError(401, 'invalid_token', 'Invalid webhook token');

    const { allowed, retryAfterSeconds } = await this.limiter.hit(webhookId);
    if (!allowed) {
      throw new AppError(429, 'rate_limited', 'This webhook is being used too quickly', {
        'retry-after': String(retryAfterSeconds),
      });
    }

    return this.messages.send({
      author: {
        id: row.user_id,
        login: row.login,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        isAdmin: false,
        isBot: true,
      },
      channelId: row.channel_id,
      content: stripMassMentions(body.content),
      embeds: body.embeds,
      source: { webhookId, displayName: body.username, avatarUrl: body.avatarUrl },
    });
  }

  private async requireManagedChannel(actor: Actor, channelId: string): Promise<void> {
    const channel = await this.channels.requireMember(channelId, actor.id);
    if (!channel.guild_id) {
      throw new AppError(400, 'webhooks_unavailable', 'Webhooks only work in guild channels');
    }
    await this.perms.require(actor, channel.guild_id, 'manage_guild');
  }

  private async fetch(channelId: string, webhookId?: string): Promise<Webhook[]> {
    const rows = await this.db
      .selectFrom('webhooks')
      .innerJoin('users', 'users.id', 'webhooks.user_id')
      .select([
        'webhooks.id',
        'webhooks.channel_id',
        'webhooks.name',
        'webhooks.created_by',
        'webhooks.created_at',
        'users.avatar_url',
      ])
      .where('webhooks.channel_id', '=', channelId)
      .$if(webhookId !== undefined, (qb) => qb.where('webhooks.id', '=', webhookId ?? ''))
      .orderBy('webhooks.id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      name: row.name,
      avatarUrl: row.avatar_url,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
    }));
  }
}
