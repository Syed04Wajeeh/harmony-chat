import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/** The Fastify instance a module's routes are registered on (Zod-typed schemas). */
export type RouteScope = Parameters<FastifyPluginAsyncZod>[0];
import type { Redis } from 'ioredis';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { z } from 'zod';
import type {
  BotMessage,
  BotScope,
  Channel,
  CommandDefinition,
  DirectoryUser,
  Message,
  OptionValue,
  User,
} from '@harmony/shared';
import type { BotPrincipal } from '../bots/auth.js';
import type { Database } from '../db/schema.js';
import type { MessageReader } from '../messages/reader.js';
import type { MessageDecorator } from '../messages/decorators.js';
import type { OutboxEvent } from '../events/outbox.js';
import type { SendMessageInput as SendInput } from '../messages/service.js';
import type { Storage } from '../uploads/storage.js';
import type { RateLimiter } from '../rate-limit.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Makes the route answer 404 `module_disabled` for guilds where this module is switched
     * off. Needs `moduleScope` to say what `:id` (or `:guildId`) in the path refers to.
     */
    module?: string;
    moduleScope?: 'guild' | 'channel' | 'message';
  }
}

/** What a module is. Listed in `modules/index.ts`; `register` is called once at startup. */
export interface HarmonyModule<TConfig = unknown, TSettings = unknown> {
  /** Kebab-case. Also the prefix of the module's WebSocket frames (`polls.updated`). */
  id: string;
  name: string;
  description: string;
  /** Optional modules can be switched off per guild by its owner; the rest are always on. */
  optional: boolean;
  dependsOn?: readonly string[];
  /** Directory of Kysely migrations the module owns. Tracked in the module's own table. */
  migrationsDir?: string;
  /** Environment variables the module reads (parsed once, available as `ctx.config`). */
  config?: z.ZodType<TConfig>;
  /** Per-guild settings. Every field needs a default, so a guild that never configured works. */
  guildSettings?: z.ZodType<TSettings>;
  register: (ctx: ModuleContext<TConfig, TSettings>) => void | Promise<void>;
  /**
   * Core realtime frame types this module may publish. Only a module that takes over a core
   * feature needs it (reactions publishes `reaction.added`); everything else uses `<id>.<name>`.
   */
  coreFrames?: readonly string[];
  /** Hooks for the worker process, which loads the same module list. */
  registerWorker?: (ctx: WorkerModuleContext<TConfig>) => void | Promise<void>;
}

/** Drops the generics so differently typed modules fit in one list. */
export function defineModule<TConfig = unknown, TSettings = unknown>(
  module: HarmonyModule<TConfig, TSettings>,
): HarmonyModule {
  return module as HarmonyModule;
}

export type ChannelRow = Selectable<Database['channels']>;

/** A message looked up for an access check. */
export interface MessageTarget {
  id: string;
  channel_id: string;
  author_id: string;
  deleted_at: Date | null;
  guild_id: string | null;
  isMember: boolean;
}

/** Fired after the change committed, in this process only. Not the outbox, not Redis. */
export interface DomainEventMap {
  'message.created': { guildId: string | null; channelId: string; message: Message };
  'message.updated': { guildId: string | null; channelId: string; message: Message };
  'message.deleted': { guildId: string | null; channelId: string; messageId: string };
  'reaction.added': ReactionEvent;
  'reaction.removed': ReactionEvent;
  'member.joined': { guildId: string; user: User };
  'member.left': { guildId: string; userId: string };
  'channel.created': { guildId: string | null; channel: Channel };
}
export type DomainEventName = keyof DomainEventMap;

interface ReactionEvent {
  guildId: string | null;
  channelId: string;
  messageId: string;
  emoji: string;
  userId: string;
}

export interface WsCaller {
  user: DirectoryUser;
  bot: BotPrincipal | null;
  log: FastifyBaseLogger;
}

export interface CommandCall {
  user: DirectoryUser;
  guildId: string;
  channelId: string;
  options: Record<string, OptionValue>;
}

/**
 * What a built-in command answers: a public message (posted as the caller) or an ephemeral
 * note only the caller sees. Return nothing when the handler already posted something itself.
 */
export type CommandResult = z.input<typeof BotMessage> | undefined;

export interface BuiltinCommand {
  name: string;
  description: string;
  options?: z.input<typeof CommandDefinition>['options'];
  handler: (call: CommandCall) => CommandResult | Promise<CommandResult>;
}

export interface ModuleContext<TConfig = unknown, TSettings = unknown> {
  readonly id: string;
  readonly log: FastifyBaseLogger;
  readonly db: Kysely<Database>;
  readonly config: TConfig;
  readonly storage: Storage;
  /** For coordination across instances (locks). Prefer `publish` and `limiter` where they fit. */
  readonly redis: Redis;
  readonly instanceId: string;

  /** Fastify routes mounted under /api: auth, bot scopes, rate limits and errors all apply. */
  routes(plugin: (app: RouteScope) => void | Promise<void>): void;
  /** Throws 404 `module_disabled` when the module is off in the guild. DMs have no guild. */
  requireEnabled(guildId: string | null): Promise<void>;

  settings: { get(guildId: string | null): Promise<TSettings> };

  ws: {
    /** `type` must be `<moduleId>.<name>`. Bots may only send it if `scope` is given and held. */
    on<S extends z.ZodType>(
      type: string,
      schema: S,
      handler: (frame: z.output<S>, caller: WsCaller) => void | Promise<void>,
      options?: { scope?: BotScope },
    ): void;
  };

  events: {
    on<K extends DomainEventName>(
      name: K,
      handler: (event: DomainEventMap[K]) => void | Promise<void>,
    ): void;
    emit<K extends DomainEventName>(name: K, event: DomainEventMap[K]): void;
  };

  messages: {
    decorate(decorator: MessageDecorator): void;
    send(input: SendInput): Promise<Message>;
    /**
     * Sends a message that carries this module's marker. `setup` runs in the same
     * transaction, after the message row exists, so the module's own rows commit with it.
     */
    sendMarked(
      input: SendInput,
      setup: (trx: Transaction<Database>, messageId: string) => Promise<void>,
    ): Promise<Message>;
    /** The message with the caller's membership of its channel, or 404. */
    find(messageId: string, userId: string): Promise<MessageTarget>;
    /**
     * For modules that keep state in a message's own columns (pins): runs `change` in a
     * transaction and, if it reports a change, announces `message.updated` everywhere.
     */
    update(
      target: Pick<MessageTarget, 'id' | 'channel_id' | 'guild_id'>,
      change: (trx: Transaction<Database>) => Promise<boolean>,
    ): Promise<{ changed: boolean; message: Message }>;
    load(messageId: string): Promise<Message>;
    /** Reads messages in their API shape (author, reactions, attachments, module data). */
    reader: MessageReader;
  };

  channels: {
    /** Loads a channel the user belongs to; 404 or 403 otherwise. */
    requireMember(channelId: string, userId: string): Promise<ChannelRow>;
  };

  commands: { register(command: BuiltinCommand): void };

  /** Goes out through Redis, so every instance delivers it to its own sockets. */
  publish: {
    channel(channelId: string, frame: ModuleFrameOut): Promise<void>;
    user(userId: string, frame: ModuleFrameOut): Promise<void>;
  };

  outbox: { enqueue(trx: Transaction<Database>, event: OutboxEvent): Promise<void> };
  limiter(name: string, max: number, windowSeconds: number): RateLimiter;

  /** Declares a permission key for the role system; nothing enforces it yet. */
  permissions: { define(key: string, description: string): void };

  onReady(fn: () => void | Promise<void>): void;
  onClose(fn: () => void | Promise<void>): void;
}

export type ModuleFrameOut = { type: string } & Record<string, unknown>;

export interface WorkerModuleContext<TConfig = unknown> {
  readonly id: string;
  readonly log: { info(o: object, m: string): void; warn(o: object, m: string): void };
  readonly db: Kysely<Database>;
  readonly config: TConfig;
  /** Runs `job` repeatedly while the worker lives; a throwing job is logged and retried. */
  every(name: string, intervalMs: number, job: () => Promise<void>): void;
}
