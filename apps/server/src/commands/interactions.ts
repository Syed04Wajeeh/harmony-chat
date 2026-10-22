import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  BotMessage,
  INTERACTION_TTL_SECONDS,
  InteractionResponse,
  stripMassMentions,
  validateCommandOptions,
  type CommandOption,
  type DirectoryUser,
  type InteractionFailureReason,
  type InteractionPayload,
  type InvokeCommandBody,
  type Message,
} from '@harmony/shared';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from '@harmony/shared/signature';
import { generateSecret, hashSecret, verifySecret } from '../bots/token.js';
import type { ChannelService } from '../channels/service.js';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { MessageService } from '../messages/service.js';
import type { BuiltinCommands, RegisteredCommand } from '../modules/builtin-commands.js';
import type { GuildModuleState } from '../modules/guild-state.js';
import { OutboundError, type PrivateAllowlist } from '../outbound/policy.js';
import { safeFetch } from '../outbound/safe-fetch.js';
import type { RateLimiter } from '../rate-limit.js';
import type { EventBus } from '../realtime/events.js';

export interface InteractionLogger {
  warn(obj: object, msg: string): void;
}

interface Target {
  interactionId: string;
  channelId: string;
  guildId: string;
  command: string;
  botId: string;
  user: DirectoryUser;
  nonce: string | undefined;
}

const DUMMY_HASH = Buffer.alloc(32);

/** Runs slash command invocations: validate, record, call the bot, relay its answer. */
export class InteractionService {
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly events: EventBus,
    private readonly channels: ChannelService,
    private readonly messages: MessageService,
    private readonly limiter: RateLimiter,
    private readonly options: { deadlineMs: number; allowlist: PrivateAllowlist },
    private readonly log: InteractionLogger,
    private readonly builtins: BuiltinCommands,
    private readonly moduleState: GuildModuleState,
  ) {}

  /** Waits for in-flight bot calls; used on shutdown and by tests. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  /**
   * Validates and records the invocation, then calls the bot in the background; the invoker
   * hears the outcome through their user topic (or as a normal message).
   */
  async invoke(user: DirectoryUser, channelId: string, body: InvokeCommandBody) {
    if (!(await this.limiter.consume(user.id))) {
      throw new AppError(429, 'rate_limited', 'You are running commands too quickly');
    }
    const channel = await this.channels.requireMember(channelId, user.id);
    if (!channel.guild_id) {
      throw new AppError(400, 'commands_unavailable', 'Commands only work in guild channels');
    }
    if (channel.archived_at) throw new AppError(409, 'channel_archived', 'Channel is archived');
    const guildId = channel.guild_id;

    // A built-in wins over a bot's command of the same name, but only where its module is on.
    const builtin = this.builtins.get(body.name);
    if (builtin && (await this.moduleState.isEnabled(guildId, builtin.moduleId))) {
      return this.invokeBuiltin(builtin, user, channelId, guildId, body);
    }

    const command = await this.db
      .selectFrom('bot_commands as c')
      .innerJoin('bots as b', 'b.user_id', 'c.bot_id')
      .innerJoin('users as bu', 'bu.id', 'b.user_id')
      .innerJoin('users as owner', 'owner.id', 'bu.bot_owner_id')
      .select([
        'c.bot_id',
        'c.options',
        'b.interactions_url',
        'b.signing_secret',
        'owner.is_admin as owner_is_admin',
      ])
      .where('c.guild_id', '=', guildId)
      .where('c.name', '=', body.name)
      .executeTakeFirst();
    if (!command) throw new AppError(404, 'unknown_command', `Unknown command /${body.name}`);
    if (!command.interactions_url) {
      throw new AppError(409, 'bot_unavailable', 'This bot cannot receive commands');
    }

    const definitions = command.options as CommandOption[];
    const checked = validateCommandOptions(definitions, body.options);
    if (!checked.ok) throw new AppError(400, 'invalid_options', checked.error);
    await this.checkReferences(definitions, checked.values, guildId, user.id);

    const token = generateSecret();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INTERACTION_TTL_SECONDS * 1000);
    const row = await this.db
      .insertInto('interactions')
      .values({
        token_hash: hashSecret(token),
        bot_id: command.bot_id,
        user_id: user.id,
        channel_id: channelId,
        command_name: body.name,
        options: JSON.stringify(checked.values),
        nonce: body.nonce ?? null,
        expires_at: expiresAt,
      })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow();

    const target: Target = {
      interactionId: row.id,
      channelId,
      guildId,
      command: body.name,
      botId: command.bot_id,
      user,
      nonce: body.nonce,
    };
    const payload: InteractionPayload = {
      id: row.id,
      token,
      type: 'command',
      command: { name: body.name, options: checked.values },
      guildId,
      channelId,
      user: { id: user.id, login: user.login, displayName: user.displayName },
      createdAt: row.created_at.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const run = this.dispatch(target, payload, {
      url: command.interactions_url,
      secret: command.signing_secret,
      ownerIsAdmin: command.owner_is_admin,
    })
      .catch((err: unknown) => this.log.warn({ err }, 'interaction dispatch failed'))
      .finally(() => this.inflight.delete(run));
    this.inflight.add(run);
    return { interactionId: row.id };
  }

  /**
   * Built-in commands run in this process, to completion, before the request is answered.
   * Validation and the shape of the outcome match bot commands: a public message or an
   * ephemeral note, delivered the same way. A public answer is posted as the caller.
   */
  private async invokeBuiltin(
    builtin: RegisteredCommand,
    user: DirectoryUser,
    channelId: string,
    guildId: string,
    body: InvokeCommandBody,
  ) {
    const definitions = builtin.definition.options;
    const checked = validateCommandOptions(definitions, body.options);
    if (!checked.ok) throw new AppError(400, 'invalid_options', checked.error);
    await this.checkReferences(definitions, checked.values, guildId, user.id);

    const interactionId = BigInt(`0x${randomBytes(7).toString('hex')}`).toString();
    const result = await builtin.handler({ user, guildId, channelId, options: checked.values });
    if (result !== undefined) {
      const answer = BotMessage.parse(result);
      if (answer.ephemeral) {
        await this.sendEphemeral(user.id, {
          interactionId,
          channelId,
          command: body.name,
          botId: null,
          source: builtin.moduleName,
          nonce: body.nonce,
          message: answer,
        });
      } else {
        await this.post(user, channelId, answer);
      }
    }
    return { interactionId };
  }

  /** A bot's late answer to a deferred interaction; the interaction token is the credential. */
  async followup(id: string, token: string, message: BotMessage): Promise<Message | null> {
    const row = await this.db
      .selectFrom('interactions as i')
      .innerJoin('users as bu', 'bu.id', 'i.bot_id')
      .select([
        'i.token_hash',
        'i.expires_at',
        'i.bot_id',
        'i.user_id',
        'i.channel_id',
        'i.command_name',
        'i.nonce',
        'bu.login as bot_login',
        'bu.display_name as bot_name',
        'bu.avatar_url as bot_avatar',
      ])
      .where('i.id', '=', id)
      .executeTakeFirst();
    const valid = verifySecret(token, row?.token_hash ?? DUMMY_HASH);
    if (!row || !valid) throw new AppError(401, 'invalid_token', 'Invalid interaction token');
    if (row.expires_at.getTime() < Date.now()) {
      throw new AppError(410, 'interaction_expired', 'This interaction has expired');
    }
    if (message.ephemeral) {
      await this.sendEphemeral(row.user_id, {
        interactionId: id,
        channelId: row.channel_id,
        command: row.command_name,
        botId: row.bot_id,
        nonce: row.nonce ?? undefined,
        message,
      });
      return null;
    }
    return this.post(
      {
        id: row.bot_id,
        login: row.bot_login,
        displayName: row.bot_name,
        avatarUrl: row.bot_avatar,
        isAdmin: false,
        isBot: true,
      },
      row.channel_id,
      message,
    );
  }

  private async dispatch(
    target: Target,
    payload: InteractionPayload,
    bot: { url: string; secret: string; ownerIsAdmin: boolean },
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    let result;
    try {
      result = await safeFetch(bot.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Harmony-Interactions/1',
          [TIMESTAMP_HEADER]: String(timestamp),
          [SIGNATURE_HEADER]: sign(bot.secret, timestamp, body),
        },
        body,
        timeoutMs: this.options.deadlineMs,
        ownerIsAdmin: bot.ownerIsAdmin,
        allowlist: this.options.allowlist,
      });
    } catch (error) {
      return this.fail(target, failureReason(error));
    }
    if (result.status < 200 || result.status >= 300) return this.fail(target, 'bad_status');

    let response;
    try {
      if (result.truncated) throw new Error('response too large');
      response = InteractionResponse.safeParse(JSON.parse(result.body.toString('utf8')));
    } catch {
      return this.fail(target, 'invalid_response');
    }
    if (!response.success) return this.fail(target, 'invalid_response');

    const answer = response.data;
    if (answer.type === 'deferred') {
      await this.events.toUser(target.user.id, {
        type: 'interaction.pending',
        interactionId: target.interactionId,
        channelId: target.channelId,
        command: target.command,
        botId: target.botId,
        expiresAt: new Date(Date.now() + INTERACTION_TTL_SECONDS * 1000).toISOString(),
        ...(target.nonce && { nonce: target.nonce }),
      });
      return;
    }
    if (answer.ephemeral) {
      await this.sendEphemeral(target.user.id, { ...target, message: answer });
      return;
    }
    try {
      const botUser = await this.botUser(target.botId);
      await this.post(botUser, target.channelId, answer);
    } catch (error) {
      this.log.warn({ err: error }, 'could not post interaction response');
      await this.fail(target, 'post_failed');
    }
  }

  private async post(author: DirectoryUser, channelId: string, message: BotMessage) {
    return this.messages.send({
      author,
      channelId,
      content: stripMassMentions(message.content),
      embeds: message.embeds,
    });
  }

  private async botUser(botId: string): Promise<DirectoryUser> {
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'login', 'display_name', 'avatar_url'])
      .where('id', '=', botId)
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      login: row.login,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      isAdmin: false,
      isBot: true,
    };
  }

  private async sendEphemeral(
    userId: string,
    info: {
      interactionId: string;
      channelId: string;
      command: string;
      botId: string | null;
      source?: string;
      nonce: string | undefined;
      message: BotMessage;
    },
  ): Promise<void> {
    await this.events.toUser(userId, {
      type: 'interaction.ephemeral',
      interactionId: info.interactionId,
      channelId: info.channelId,
      command: info.command,
      botId: info.botId,
      ...(info.source && { source: info.source }),
      content: info.message.content,
      ...(info.message.embeds && { embeds: info.message.embeds }),
      ...(info.nonce && { nonce: info.nonce }),
    });
  }

  private async fail(target: Target, reason: InteractionFailureReason): Promise<void> {
    await this.events.toUser(target.user.id, {
      type: 'interaction.failed',
      interactionId: target.interactionId,
      channelId: target.channelId,
      command: target.command,
      botId: target.botId,
      reason,
      ...(target.nonce && { nonce: target.nonce }),
    });
  }

  /** `user` and `channel` options must point at things the invoker can see in this guild. */
  private async checkReferences(
    definitions: readonly CommandOption[],
    values: Record<string, string | number | boolean>,
    guildId: string,
    invokerId: string,
  ): Promise<void> {
    for (const definition of definitions) {
      const value = values[definition.name];
      if (value === undefined) continue;
      if (definition.type === 'user') {
        const member = await this.db
          .selectFrom('guild_members')
          .select('user_id')
          .where('guild_id', '=', guildId)
          .where('user_id', '=', String(value))
          .executeTakeFirst();
        if (!member) {
          throw new AppError(400, 'invalid_options', `Option "${definition.name}" is not a member`);
        }
      } else if (definition.type === 'channel') {
        const channel = await this.db
          .selectFrom('channels')
          .innerJoin('channel_members', 'channel_members.channel_id', 'channels.id')
          .select('channels.id')
          .where('channels.id', '=', String(value))
          .where('channels.guild_id', '=', guildId)
          .where('channel_members.user_id', '=', invokerId)
          .executeTakeFirst();
        if (!channel) {
          throw new AppError(
            400,
            'invalid_options',
            `Option "${definition.name}" is not a channel`,
          );
        }
      }
    }
  }
}

function failureReason(error: unknown): InteractionFailureReason {
  if (error instanceof OutboundError) {
    if (error.code === 'timeout') return 'timeout';
    if (error.code === 'blocked_address' || error.code === 'invalid_url') return 'blocked_url';
  }
  return 'unreachable';
}
