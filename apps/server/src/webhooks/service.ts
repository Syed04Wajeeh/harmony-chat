import type { Kysely } from 'kysely';
import {
  WebhookTemplate,
  stripMassMentions,
  supportsSignature,
  type CreateWebhookBody,
  type DirectoryUser,
  type Message,
  type PreviewWebhookBody,
  type PreviewWebhookResponse,
  type UpdateWebhookBody,
  type Webhook,
  type WebhookFormat,
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
import type { Headers } from './presets/index.js';
import { renderWebhook } from './render.js';
import { verifySignature } from './signature.js';

type Actor = Pick<DirectoryUser, 'id' | 'isAdmin'>;

const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const DUMMY_HASH = Buffer.alloc(32);

/** An incoming request as the route hands it over: the raw bytes (for signatures) and the parsed body. */
export interface IncomingWebhook {
  raw: Buffer;
  body: unknown;
  headers: Headers;
}

/** Checks that the format, template and secret fit together. */
function checkConfig(format: WebhookFormat, template: unknown, secret: string | null): void {
  if (format === 'template' && !template) {
    throw new AppError(400, 'template_required', 'The template format needs a template');
  }
  if (secret !== null && !supportsSignature(format)) {
    throw new AppError(
      400,
      'signature_unsupported',
      'Signature secrets work with the GitHub and Forgejo formats only',
    );
  }
}

const readTemplate = (stored: unknown): WebhookTemplate | null => {
  const parsed = WebhookTemplate.safeParse(stored);
  return parsed.success ? parsed.data : null;
};

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
    const format = body.format ?? 'discord';
    const secret = body.secret ?? null;
    checkConfig(format, body.template, secret);
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
          format,
          template: body.template ? JSON.stringify(body.template) : null,
          signature_secret: secret,
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

  async update(actor: Actor, webhookId: string, body: UpdateWebhookBody): Promise<Webhook> {
    const row = await this.db
      .selectFrom('webhooks')
      .select(['channel_id', 'user_id', 'format', 'template', 'signature_secret'])
      .where('id', '=', webhookId)
      .executeTakeFirst();
    if (!row) throw new AppError(404, 'webhook_not_found', 'Webhook not found');
    await this.requireManagedChannel(actor, row.channel_id);

    const format = body.format ?? (row.format as WebhookFormat);
    const template = body.template === undefined ? readTemplate(row.template) : body.template;
    // Leaving a signed format drops its secret instead of keeping one nothing can use.
    let secret = body.secret === undefined ? row.signature_secret : body.secret;
    if (body.secret === undefined && !supportsSignature(format)) secret = null;
    checkConfig(format, template, secret);

    await this.db
      .updateTable('webhooks')
      .set({
        format,
        template: template ? JSON.stringify(template) : null,
        signature_secret: secret,
        ...(body.name !== undefined && { name: body.name }),
      })
      .where('id', '=', webhookId)
      .execute();
    if (body.name !== undefined) {
      await this.db
        .updateTable('users')
        .set({ display_name: body.name })
        .where('id', '=', row.user_id)
        .execute();
    }
    const [webhook] = await this.fetch(row.channel_id, webhookId);
    if (!webhook) throw new Error('webhook vanished');
    return webhook;
  }

  /** Renders a sample body exactly as the live endpoint would, without posting anything. */
  async preview(
    actor: Actor,
    webhookId: string,
    input: PreviewWebhookBody,
  ): Promise<PreviewWebhookResponse> {
    const row = await this.db
      .selectFrom('webhooks')
      .select(['channel_id', 'format', 'template'])
      .where('id', '=', webhookId)
      .executeTakeFirst();
    if (!row) throw new AppError(404, 'webhook_not_found', 'Webhook not found');
    await this.requireManagedChannel(actor, row.channel_id);
    const format = input.format ?? (row.format as WebhookFormat);
    const template = input.template ?? readTemplate(row.template);
    checkConfig(format, template, null);
    const headers = Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const rendered = renderWebhook({ format, template }, headers, input.body);
    if (!rendered) return { message: null };
    return {
      message: {
        content: stripMassMentions(rendered.content),
        embeds: rendered.embeds,
        ...(rendered.username && { username: rendered.username }),
      },
    };
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

  /**
   * Posts a message through the single send path as the webhook's own author. Null when the
   * preset or template decides the event is not worth a message.
   */
  async execute(
    webhookId: string,
    token: string,
    incoming: IncomingWebhook,
  ): Promise<Message | null> {
    const row = await this.db
      .selectFrom('webhooks')
      .innerJoin('users', 'users.id', 'webhooks.user_id')
      .select([
        'webhooks.id',
        'webhooks.channel_id',
        'webhooks.token_hash',
        'webhooks.format',
        'webhooks.template',
        'webhooks.signature_secret',
        'users.id as user_id',
        'users.login',
        'users.display_name',
        'users.avatar_url',
      ])
      .where('webhooks.id', '=', webhookId)
      .executeTakeFirst();
    const valid = verifySecret(token, row?.token_hash ?? DUMMY_HASH);
    if (!row || !valid) throw new AppError(401, 'invalid_token', 'Invalid webhook token');

    const format = row.format as WebhookFormat;
    // The secret is only ever set for formats that sign; a missing or bad signature is refused
    // before anything is parsed.
    if (row.signature_secret && supportsSignature(format)) {
      if (!verifySignature(format, incoming.headers, incoming.raw, row.signature_secret)) {
        throw new AppError(401, 'invalid_signature', 'Missing or invalid webhook signature');
      }
    }

    const { allowed, retryAfterSeconds } = await this.limiter.hit(webhookId);
    if (!allowed) {
      throw new AppError(429, 'rate_limited', 'This webhook is being used too quickly', {
        'retry-after': String(retryAfterSeconds),
      });
    }

    const body = renderWebhook(
      { format, template: readTemplate(row.template) },
      incoming.headers,
      incoming.body,
    );
    if (!body) return null;

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
        'webhooks.format',
        'webhooks.template',
        'webhooks.signature_secret',
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
      format: row.format as WebhookFormat,
      template: readTemplate(row.template),
      hasSecret: row.signature_secret !== null,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
    }));
  }
}
