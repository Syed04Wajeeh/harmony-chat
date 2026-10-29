import { z } from 'zod';
import { Id } from './chat.js';
import { MessageComponents, PanelSlug } from './components.js';
import { Embed, EmbedsInput } from './embeds.js';
import { PanelView } from './panels.js';
import { ScheduleSlug } from './schedule.js';
import { MAX_WEBHOOK_CONTENT, MAX_WEBHOOK_SECRET, WebhookFormat } from './webhook-format.js';
import { WebhookTemplate } from './webhook-template.js';

export const BOT_SCOPES = [
  'messages.read',
  'messages.write',
  'reactions.write',
  'channels.read',
  'commands',
  'events',
  'panels.write',
] as const;
export const BotScope = z.enum(BOT_SCOPES);
export type BotScope = z.infer<typeof BotScope>;

export const EVENT_TYPES = [
  'message.created',
  'message.updated',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
  'guild.member_joined',
  'guild.member_left',
] as const;
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

export const BOT_NAME_MAX = 32;
export const MAX_BOT_RESPONSE_CONTENT = 4000;

const BotName = z.string().trim().min(1).max(BOT_NAME_MAX);
export const OutboundUrl = z.url({ protocol: /^https?$/ }).max(2048);

/**
 * How interactions or events reach a bot: `http` (signed POST to its URL), `gateway` (frames over
 * its WebSocket connection; the bot has the scope but no URL) or `off` (it lacks the scope, or
 * for events has no event types).
 */
export const DELIVERY_MODES = ['http', 'gateway', 'off'] as const;
export const DeliveryMode = z.enum(DELIVERY_MODES);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

export const Bot = z.object({
  id: Id,
  name: z.string(),
  avatarUrl: z.string().nullable(),
  ownerId: Id,
  scopes: z.array(BotScope),
  interactionsUrl: z.string().nullable(),
  eventsUrl: z.string().nullable(),
  eventTypes: z.array(EventType),
  delivery: z.object({ interactions: DeliveryMode, events: DeliveryMode }),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type Bot = z.infer<typeof Bot>;

export const BotParams = z.object({ id: Id });
export const GuildBotParams = z.object({ id: Id, botId: Id });
export const BotGuildParams = z.object({ id: Id, guildId: Id });
export const DeliveryParams = z.object({ id: Id, deliveryId: Id });

export const CreateBotBody = z.object({
  name: BotName,
  scopes: z.array(BotScope).max(BOT_SCOPES.length).default(['messages.read', 'messages.write']),
  interactionsUrl: OutboundUrl.optional(),
  eventsUrl: OutboundUrl.optional(),
  eventTypes: z.array(EventType).optional(),
});
export type CreateBotBody = z.input<typeof CreateBotBody>;

export const UpdateBotBody = z
  .object({
    name: BotName.optional(),
    scopes: z.array(BotScope).optional(),
    interactionsUrl: OutboundUrl.nullable().optional(),
    eventsUrl: OutboundUrl.nullable().optional(),
    eventTypes: z.array(EventType).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateBotBody = z.infer<typeof UpdateBotBody>;

/** Secrets appear in these responses once; only a hash of the token is stored. */
export const CreatedBot = z.object({ bot: Bot, token: z.string(), signingSecret: z.string() });
export const RotatedToken = z.object({ token: z.string() });
export const RotatedSigningSecret = z.object({ signingSecret: z.string() });
export const ListBotsResponse = z.object({ bots: z.array(Bot) });
export const AddGuildBotBody = z.object({ botId: Id });

export const BOT_TOKEN_PATTERN = /^hb_(\d{1,18})_([A-Za-z0-9_-]{43})$/;

/* Slash commands */

export const COMMAND_OPTION_TYPES = ['string', 'integer', 'boolean', 'user', 'channel'] as const;
export const CommandOptionType = z.enum(COMMAND_OPTION_TYPES);
export type CommandOptionType = z.infer<typeof CommandOptionType>;

export const MAX_COMMAND_OPTIONS = 10;
export const MAX_COMMANDS_PER_GUILD = 100;
export const MAX_STRING_OPTION_LENGTH = 1000;

const CommandName = z
  .string()
  .regex(/^[a-z0-9-]{1,32}$/, 'Use 1-32 lowercase letters, digits or hyphens');

export const CommandOption = z.object({
  name: CommandName,
  description: z.string().min(1).max(100),
  type: CommandOptionType,
  required: z.boolean().default(false),
});
export type CommandOption = z.infer<typeof CommandOption>;

const unique = (names: string[]) => new Set(names).size === names.length;

export const CommandDefinition = z.object({
  name: CommandName,
  description: z.string().min(1).max(100),
  options: z
    .array(CommandOption)
    .max(MAX_COMMAND_OPTIONS)
    .refine((options) => unique(options.map((o) => o.name)), { message: 'Duplicate option name' })
    .default([]),
});
export type CommandDefinition = z.infer<typeof CommandDefinition>;

export const PutCommandsBody = z
  .array(CommandDefinition)
  .max(MAX_COMMANDS_PER_GUILD)
  .refine((commands) => unique(commands.map((c) => c.name)), { message: 'Duplicate command name' });

/**
 * `botId` is null for built-in commands, which come from a module: `botName` is then the
 * module's name and `moduleId` its id.
 */
export const GuildCommand = CommandDefinition.extend({
  botId: Id.nullable(),
  botName: z.string(),
  moduleId: z.string().optional(),
});
export type GuildCommand = z.infer<typeof GuildCommand>;
export const ListCommandsResponse = z.object({ commands: z.array(GuildCommand) });
export const PutCommandsResponse = z.object({ commands: z.array(CommandDefinition) });

export const OptionValue = z.union([z.string(), z.number(), z.boolean()]);
export type OptionValue = z.infer<typeof OptionValue>;
export const CommandOptionValues = z.record(z.string(), OptionValue);
export type CommandOptionValues = z.infer<typeof CommandOptionValues>;

export const INTERACTION_TTL_SECONDS = 15 * 60;
export const INTERACTION_DEADLINE_MS = 3000;

export const InvokeCommandBody = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,32}$/),
  options: CommandOptionValues.default({}),
  nonce: z.string().min(1).max(64).optional(),
});
export type InvokeCommandBody = z.infer<typeof InvokeCommandBody>;
export const InvokeCommandResponse = z.object({ interactionId: Id });

export type OptionValidation =
  { ok: true; values: Record<string, OptionValue> } | { ok: false; error: string };

/** Checks supplied option values against a definition; id-typed options are checked for shape only. */
export function validateCommandOptions(
  definitions: readonly CommandOption[],
  supplied: Record<string, OptionValue>,
): OptionValidation {
  const known = new Map(definitions.map((def) => [def.name, def]));
  for (const name of Object.keys(supplied)) {
    if (!known.has(name)) return { ok: false, error: `Unknown option "${name}"` };
  }
  const values: Record<string, OptionValue> = {};
  for (const def of definitions) {
    const value = supplied[def.name];
    if (value === undefined) {
      if (def.required) return { ok: false, error: `Option "${def.name}" is required` };
      continue;
    }
    const bad = (expected: string) => ({
      ok: false as const,
      error: `Option "${def.name}" must be ${expected}`,
    });
    switch (def.type) {
      case 'string':
        if (typeof value !== 'string' || value.length > MAX_STRING_OPTION_LENGTH) {
          return bad(`a string of at most ${MAX_STRING_OPTION_LENGTH} characters`);
        }
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) return bad('an integer');
        break;
      case 'boolean':
        if (typeof value !== 'boolean') return bad('a boolean');
        break;
      case 'user':
      case 'channel':
        if (typeof value !== 'string' || !Id.safeParse(value).success) return bad('an id');
        break;
    }
    values[def.name] = value;
  }
  return { ok: true, values };
}

/** What a bot answers to an interaction request, or sends as a follow-up. */
export const BotMessage = z
  .object({
    content: z.string().max(MAX_BOT_RESPONSE_CONTENT).default(''),
    embeds: EmbedsInput.optional(),
    ephemeral: z.boolean().default(false),
    /** Buttons under the message; ignored for ephemeral answers. */
    components: MessageComponents.optional(),
  })
  .refine((m) => m.content.length > 0 || (m.embeds?.length ?? 0) > 0, {
    message: 'Message is empty',
    path: ['content'],
  });
export type BotMessage = z.infer<typeof BotMessage>;

export const InteractionResponse = z.union([
  z.object({ type: z.literal('message') }).and(BotMessage),
  z.object({ type: z.literal('deferred') }),
  /** Only valid as the answer to a button on a panel: replaces that panel's view. */
  z.object({ type: z.literal('update_panel'), view: PanelView }),
]);
export type InteractionResponse = z.infer<typeof InteractionResponse>;

export const InteractionFollowupParams = z.object({
  id: Id,
  token: z.string().min(1).max(100),
});

export const InteractionFailureReason = z.enum([
  'timeout',
  'unreachable',
  'bad_status',
  'invalid_response',
  'blocked_url',
  'post_failed',
]);
export type InteractionFailureReason = z.infer<typeof InteractionFailureReason>;

/** Which button was clicked: one on a panel, or one under a bot message. */
export const ActionSource = z.union([
  z.object({ panelId: Id }).strict(),
  z.object({ messageId: Id }).strict(),
]);
export type ActionSource = z.infer<typeof ActionSource>;

export const InvokeActionBody = z.object({
  source: ActionSource,
  actionId: PanelSlug,
  nonce: z.string().min(1).max(64).optional(),
});
export type InvokeActionBody = z.infer<typeof InvokeActionBody>;

const payloadCore = {
  id: Id,
  token: z.string(),
  guildId: Id,
  channelId: Id,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
};
const payloadBase = {
  ...payloadCore,
  user: z.object({ id: Id, login: z.string(), displayName: z.string() }),
};

/** The signed request body sent to a bot's `interactions_url`; discriminated on `type`. */
export const InteractionPayload = z.discriminatedUnion('type', [
  z.object({
    ...payloadBase,
    type: z.literal('command'),
    command: z.object({ name: z.string(), options: CommandOptionValues }),
  }),
  z.object({
    ...payloadBase,
    type: z.literal('action'),
    action: z.object({
      id: PanelSlug,
      source: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('panel'), panelId: Id, key: PanelSlug }),
        z.object({ kind: z.literal('message'), messageId: Id }),
      ]),
    }),
  }),
  /** A schedule came due. No user is involved; answer with `update_panel`, a message or `deferred`. */
  z.object({
    ...payloadCore,
    type: z.literal('refresh'),
    schedule: z.object({
      id: ScheduleSlug,
      channelId: Id,
      panelKey: PanelSlug.nullable(),
    }),
  }),
]);
export type InteractionPayload = z.infer<typeof InteractionPayload>;

/* Webhooks */

export const WebhookName = z.string().trim().min(1).max(80);

export const Webhook = z.object({
  id: Id,
  channelId: Id,
  name: z.string(),
  avatarUrl: z.string().nullable(),
  format: WebhookFormat,
  template: WebhookTemplate.nullable(),
  /** Whether a signature secret is set. The secret itself is never served. */
  hasSecret: z.boolean(),
  createdBy: Id,
  createdAt: z.iso.datetime(),
});
export type Webhook = z.infer<typeof Webhook>;
export const CreatedWebhook = Webhook.extend({ url: z.string() });
export const ListWebhooksResponse = z.object({ webhooks: z.array(Webhook) });
const WebhookSecret = z.string().trim().min(8).max(MAX_WEBHOOK_SECRET);
const WebhookFormatFields = z.object({
  format: WebhookFormat.optional(),
  template: WebhookTemplate.nullable().optional(),
  /** HMAC secret for senders that sign (GitHub, Forgejo); null removes it. */
  secret: WebhookSecret.nullable().optional(),
});
export const CreateWebhookBody = z.object({
  name: WebhookName,
  avatarAttachmentId: z.uuid().optional(),
  ...WebhookFormatFields.shape,
});
export type CreateWebhookBody = z.infer<typeof CreateWebhookBody>;
export const UpdateWebhookBody = WebhookFormatFields.extend({ name: WebhookName.optional() });
export type UpdateWebhookBody = z.infer<typeof UpdateWebhookBody>;
/** Renders a sample without posting. `format` and `template` default to the saved ones. */
export const PreviewWebhookBody = z.object({
  body: z.unknown(),
  headers: z.record(z.string().max(100), z.string().max(1000)).optional(),
  format: WebhookFormat.optional(),
  template: WebhookTemplate.optional(),
});
export type PreviewWebhookBody = z.infer<typeof PreviewWebhookBody>;
export const PreviewWebhookResponse = z.object({
  /** Null when the preset or template yields nothing to post (the live endpoint answers 204). */
  message: z
    .object({ content: z.string(), embeds: z.array(Embed), username: z.string().optional() })
    .nullable(),
});
export type PreviewWebhookResponse = z.infer<typeof PreviewWebhookResponse>;
export const WebhookParams = z.object({ id: Id });
export const WebhookExecuteParams = z.object({ id: Id, token: z.string().min(1).max(100) });
export const WebhookExecuteQuery = z.object({ wait: z.enum(['true', 'false']).optional() });

/**
 * Discord-compatible webhook payload, plus Slack's `text`. Unknown keys (`tts`, `flags`,
 * `thread_name`, `allowed_mentions`, ...) are ignored so existing tools work unchanged.
 */
export const WebhookExecuteBody = z
  .object({
    content: z.string().max(MAX_WEBHOOK_CONTENT).optional(),
    text: z.string().max(MAX_WEBHOOK_CONTENT).optional(),
    username: z.string().trim().min(1).max(80).optional(),
    avatar_url: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .optional(),
    embeds: EmbedsInput.optional(),
  })
  .transform((body) => ({
    content: (body.content ?? body.text ?? '').trim(),
    username: body.username,
    avatarUrl: body.avatar_url,
    embeds: body.embeds ?? [],
  }))
  .refine((body) => body.content.length > 0 || body.embeds.length > 0, {
    message: 'Provide content, text or embeds',
    path: ['content'],
  });
export type WebhookExecuteBody = z.output<typeof WebhookExecuteBody>;
/** Largest body a non-Discord webhook accepts, matching the proxy's 1m limit. */
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

/* Event delivery */

export const EventEnvelope = z.object({
  id: Id,
  type: EventType,
  guildId: Id,
  createdAt: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'dead'] as const;
export const Delivery = z.object({
  id: Id,
  eventId: Id,
  eventType: EventType,
  status: z.enum(DELIVERY_STATUSES),
  attempts: z.number().int(),
  nextAttemptAt: z.iso.datetime(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
});
export type Delivery = z.infer<typeof Delivery>;
export const ListDeliveriesQuery = z.object({
  status: z.enum(DELIVERY_STATUSES).optional(),
  before: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ListDeliveriesResponse = z.object({ deliveries: z.array(Delivery) });
