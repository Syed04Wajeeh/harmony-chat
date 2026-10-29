import { sql, type Kysely, type Transaction } from 'kysely';
import {
  EVENT_TYPES,
  type Bot,
  type BotScope,
  type CreateBotBody,
  type DirectoryUser,
  type Delivery,
  type EventType,
  type UpdateBotBody,
} from '@harmony/shared';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { PermissionService } from '../permissions/service.js';
import { enqueueEvent, OUTBOX_CHANNEL } from '../events/outbox.js';
import { addGuildMember } from '../guilds/membership.js';
import type { DomainEvents } from '../modules/domain-events.js';
import type { EventBus } from '../realtime/events.js';
import type { OutboundValidator } from '../outbound/validator.js';
import { formatBotToken, generateSecret, generateSigningSecret, hashSecret } from './token.js';
import { createBotUser } from './users.js';

type Actor = Pick<DirectoryUser, 'id' | 'isAdmin'>;

export interface CreatedBot {
  bot: Bot;
  token: string;
  signingSecret: string;
}

const notFound = () => new AppError(404, 'bot_not_found', 'Bot not found');

export class BotService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly events: EventBus,
    private readonly validator: OutboundValidator,
    private readonly maxBotsPerUser: number,
    private readonly domain: DomainEvents,
    private readonly perms: PermissionService,
  ) {}

  async create(owner: DirectoryUser, body: CreateBotBody): Promise<CreatedBot> {
    const scopes = [...new Set(body.scopes ?? ['messages.read', 'messages.write'])];
    const eventTypes = body.eventsUrl
      ? (body.eventTypes ?? [...EVENT_TYPES])
      : (body.eventTypes ?? []);
    this.checkShape(scopes, body.interactionsUrl ?? null, body.eventsUrl ?? null, eventTypes);
    for (const url of [body.interactionsUrl, body.eventsUrl]) {
      if (url) await this.validator.assert(url, owner.isAdmin);
    }

    const secret = generateSecret();
    const signingSecret = generateSigningSecret();
    const botId = await this.db.transaction().execute(async (trx) => {
      const { count } = await trx
        .selectFrom('users')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('bot_owner_id', '=', owner.id)
        .where((eb) =>
          eb.exists(
            eb.selectFrom('bots').select('user_id').whereRef('bots.user_id', '=', 'users.id'),
          ),
        )
        .executeTakeFirstOrThrow();
      if (Number(count) >= this.maxBotsPerUser) {
        throw new AppError(409, 'bot_limit', 'You have reached the bot limit');
      }
      const id = await createBotUser(trx, { prefix: 'bot', name: body.name, ownerId: owner.id });
      await trx
        .insertInto('bots')
        .values({
          user_id: id,
          token_hash: hashSecret(secret),
          signing_secret: signingSecret,
          scopes,
          interactions_url: body.interactionsUrl ?? null,
          events_url: body.eventsUrl ?? null,
          event_types: eventTypes,
        })
        .execute();
      return id;
    });
    return { bot: await this.load(botId), token: formatBotToken(botId, secret), signingSecret };
  }

  async list(owner: Actor): Promise<Bot[]> {
    const rows = await this.query()
      .where('users.bot_owner_id', '=', owner.id)
      .orderBy('users.id')
      .execute();
    return rows.map(toBot);
  }

  async get(owner: Actor, botId: string): Promise<Bot> {
    await this.requireOwned(owner, botId);
    return this.load(botId);
  }

  async update(owner: DirectoryUser, botId: string, body: UpdateBotBody): Promise<Bot> {
    const current = await this.requireOwned(owner, botId);
    const scopes = body.scopes ? [...new Set(body.scopes)] : (current.scopes as BotScope[]);
    const interactionsUrl =
      body.interactionsUrl === undefined ? current.interactions_url : body.interactionsUrl;
    const eventsUrl = body.eventsUrl === undefined ? current.events_url : body.eventsUrl;
    let eventTypes = body.eventTypes ?? (current.event_types as EventType[]);
    if (
      body.eventsUrl &&
      !current.events_url &&
      body.eventTypes === undefined &&
      eventTypes.length === 0
    ) {
      eventTypes = [...EVENT_TYPES];
    }
    this.checkShape(scopes, interactionsUrl, eventsUrl, eventTypes);
    for (const [next, previous] of [
      [body.interactionsUrl, current.interactions_url],
      [body.eventsUrl, current.events_url],
    ] as const) {
      if (next && next !== previous) await this.validator.assert(next, owner.isAdmin);
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('bots')
        .set({
          scopes,
          interactions_url: interactionsUrl,
          events_url: eventsUrl,
          event_types: eventTypes,
        })
        .where('user_id', '=', botId)
        .execute();
      if (body.name !== undefined) {
        await trx
          .updateTable('users')
          .set({ display_name: body.name })
          .where('id', '=', botId)
          .execute();
      }
    });
    // A socket keeps the scopes it connected with, so dropping one ends the connection; the bot
    // reconnects with what it still holds.
    const lost = current.scopes.some((scope) => !scopes.includes(scope as BotScope));
    if (lost) await this.events.revokeBot(botId, 'scopes reduced');
    return this.load(botId);
  }

  /**
   * Revokes the bot: its credentials, commands and deliveries go with the `bots` row and it is
   * removed from every guild. The user row stays so the messages it wrote keep their author.
   */
  async delete(owner: Actor, botId: string): Promise<void> {
    await this.requireOwned(owner, botId);
    const removed = await this.db.transaction().execute(async (trx) => {
      const guildIds = await this.removeMemberships(trx, botId);
      await trx.deleteFrom('bots').where('user_id', '=', botId).execute();
      return guildIds;
    });
    await Promise.all(removed.map((guildId) => this.announceLeft(guildId, botId)));
    await this.events.revokeBot(botId, 'bot deleted');
  }

  /** The old token stops working immediately: authentication looks the hash up on every request. */
  async rotateToken(owner: Actor, botId: string): Promise<string> {
    await this.requireOwned(owner, botId);
    const secret = generateSecret();
    await this.db
      .updateTable('bots')
      .set({ token_hash: hashSecret(secret), token_rotated_at: new Date() })
      .where('user_id', '=', botId)
      .execute();
    await this.events.revokeBot(botId, 'token rotated');
    return formatBotToken(botId, secret);
  }

  async rotateSigningSecret(owner: Actor, botId: string): Promise<string> {
    await this.requireOwned(owner, botId);
    const signingSecret = generateSigningSecret();
    await this.db
      .updateTable('bots')
      .set({ signing_secret: signingSecret })
      .where('user_id', '=', botId)
      .execute();
    return signingSecret;
  }

  /** The caller must own the bot and have manage_guild. */
  async addToGuild(actor: DirectoryUser, guildId: string, botId: string): Promise<void> {
    await this.perms.require(actor, guildId, 'manage_guild');
    await this.requireOwned(actor, botId);
    const joined = await this.db
      .transaction()
      .execute((trx) => addGuildMember(trx, guildId, botId));
    if (!joined) return;
    const bot = await this.load(botId);
    const user = {
      id: bot.id,
      login: `bot-${bot.id}@bots.harmony.invalid`,
      displayName: bot.name,
      avatarUrl: bot.avatarUrl,
      isAdmin: false,
      isBot: true,
    };
    const members = await this.memberIds(guildId);
    await Promise.all(
      members
        .filter((id) => id !== botId)
        .map((id) => this.events.toUser(id, { type: 'guild.member_joined', guildId, user })),
    );
    this.domain.emit('member.joined', {
      guildId,
      user: {
        id: user.id,
        login: user.login,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        isBot: true,
      },
    });
  }

  /** Someone with manage_guild or the bot's owner may remove a bot from a guild. */
  async removeFromGuild(actor: DirectoryUser, guildId: string, botId: string): Promise<void> {
    const bot = await this.db
      .selectFrom('users')
      .select('bot_owner_id')
      .where('id', '=', botId)
      .where('kind', '=', 'bot')
      .executeTakeFirst();
    if (!bot) throw notFound();
    if (bot.bot_owner_id !== actor.id) await this.perms.require(actor, guildId, 'manage_guild');
    const removed = await this.db
      .transaction()
      .execute((trx) => this.removeMemberships(trx, botId, guildId));
    await Promise.all(removed.map((id) => this.announceLeft(id, botId)));
  }

  async deliveries(
    owner: Actor,
    botId: string,
    query: { status?: string | undefined; before?: string | undefined; limit: number },
  ): Promise<Delivery[]> {
    await this.requireOwned(owner, botId);
    let q = this.db
      .selectFrom('event_deliveries as d')
      .innerJoin('event_outbox as e', 'e.id', 'd.event_id')
      .select([
        'd.id',
        'd.event_id',
        'e.type',
        'd.status',
        'd.attempts',
        'd.next_attempt_at',
        'd.last_status_code',
        'd.last_error',
        'd.created_at',
        'd.delivered_at',
      ])
      .where('d.bot_id', '=', botId)
      .orderBy('d.id', 'desc')
      .limit(query.limit);
    if (query.status) q = q.where('d.status', '=', query.status);
    if (query.before) q = q.where('d.id', '<', query.before);
    return (await q.execute()).map((row) => ({
      id: row.id,
      eventId: row.event_id,
      eventType: row.type as EventType,
      status: row.status as Delivery['status'],
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at.toISOString(),
      lastStatusCode: row.last_status_code,
      lastError: row.last_error,
      createdAt: row.created_at.toISOString(),
      deliveredAt: row.delivered_at?.toISOString() ?? null,
    }));
  }

  /** Puts a delivery back in the queue with a fresh attempt budget and wakes the workers. */
  async redeliver(owner: Actor, botId: string, deliveryId: string): Promise<void> {
    await this.requireOwned(owner, botId);
    const row = await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('event_deliveries')
        .set({
          status: 'pending',
          attempts: 0,
          next_attempt_at: new Date(),
          last_error: null,
          last_status_code: null,
          delivered_at: null,
        })
        .where('id', '=', deliveryId)
        .where('bot_id', '=', botId)
        .returning('id')
        .executeTakeFirst();
      if (updated) await sql`select pg_notify(${OUTBOX_CHANNEL}, '')`.execute(trx);
      return updated;
    });
    if (!row) throw new AppError(404, 'delivery_not_found', 'Delivery not found');
  }

  private checkShape(
    scopes: readonly string[],
    interactionsUrl: string | null,
    eventsUrl: string | null,
    eventTypes: readonly string[],
  ): void {
    if (interactionsUrl && !scopes.includes('commands')) {
      throw new AppError(400, 'invalid_bot', 'interactionsUrl requires the commands scope');
    }
    if ((eventsUrl || eventTypes.length > 0) && !scopes.includes('events')) {
      throw new AppError(400, 'invalid_bot', 'eventsUrl and eventTypes require the events scope');
    }
  }

  private query() {
    return this.db
      .selectFrom('bots')
      .innerJoin('users', 'users.id', 'bots.user_id')
      .select([
        'users.id',
        'users.display_name',
        'users.avatar_url',
        'users.bot_owner_id',
        'bots.scopes',
        'bots.interactions_url',
        'bots.events_url',
        'bots.event_types',
        'bots.created_at',
        'bots.last_used_at',
      ]);
  }

  private async load(botId: string): Promise<Bot> {
    const row = await this.query().where('bots.user_id', '=', botId).executeTakeFirst();
    if (!row) throw notFound();
    return toBot(row);
  }

  /** 404 for anything that is not the actor's own bot, so ids of other people's bots are not probed. */
  private async requireOwned(actor: Actor, botId: string) {
    const row = await this.db
      .selectFrom('bots')
      .innerJoin('users', 'users.id', 'bots.user_id')
      .select([
        'bots.scopes',
        'bots.interactions_url',
        'bots.events_url',
        'bots.event_types',
        'users.bot_owner_id',
      ])
      .where('bots.user_id', '=', botId)
      .executeTakeFirst();
    if (!row || row.bot_owner_id !== actor.id) throw notFound();
    return row;
  }

  /** Removes the bot from one guild, or all of them; returns the guild ids it left. */
  private async removeMemberships(
    trx: Transaction<Database>,
    botId: string,
    onlyGuildId?: string,
  ): Promise<string[]> {
    const guildFilter = onlyGuildId ? sql`and gm.guild_id = ${onlyGuildId}` : sql``;
    const { rows } = await sql<{ guild_id: string }>`
      delete from guild_members gm
      where gm.user_id = ${botId} ${guildFilter}
      returning gm.guild_id
    `.execute(trx);
    const guildIds = rows.map((row) => row.guild_id);
    if (guildIds.length === 0) return [];
    await sql`
      delete from channel_members cm using channels c
      where cm.channel_id = c.id and cm.user_id = ${botId} and c.guild_id = any(${guildIds}::bigint[])
    `.execute(trx);
    await sql`
      delete from channel_overwrites o using channels c
      where o.channel_id = c.id and o.target_type = 'member' and o.target_id = ${botId}
        and c.guild_id = any(${guildIds}::bigint[])
    `.execute(trx);
    await trx
      .deleteFrom('bot_commands')
      .where('bot_id', '=', botId)
      .where('guild_id', 'in', guildIds)
      .execute();
    // Assignments and schedules do not outlive the membership: a removed bot stops being asked.
    await trx
      .deleteFrom('bot_schedules')
      .where('bot_id', '=', botId)
      .where('guild_id', 'in', guildIds)
      .execute();
    await sql`
      delete from channel_bots cb using channels c
      where cb.channel_id = c.id and cb.bot_id = ${botId}
        and c.guild_id = any(${guildIds}::bigint[])
    `.execute(trx);
    for (const guildId of guildIds) {
      await enqueueEvent(trx, { guildId, type: 'guild.member_left', data: { userId: botId } });
    }
    return guildIds;
  }

  private async announceLeft(guildId: string, botId: string): Promise<void> {
    this.domain.emit('member.left', { guildId, userId: botId });
    const members = await this.memberIds(guildId);
    await Promise.all(
      members.map((id) =>
        this.events.toUser(id, { type: 'guild.member_left', guildId, userId: botId }),
      ),
    );
  }

  private async memberIds(guildId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('guild_members')
      .select('user_id')
      .where('guild_id', '=', guildId)
      .execute();
    return rows.map((row) => row.user_id);
  }
}

/** No URL means the gateway: the bot connects out instead of being called. */
function deliveryModes(row: {
  scopes: string[];
  interactions_url: string | null;
  events_url: string | null;
  event_types: string[];
}): Bot['delivery'] {
  const interactions = !row.scopes.includes('commands')
    ? 'off'
    : row.interactions_url
      ? 'http'
      : 'gateway';
  const events =
    !row.scopes.includes('events') || row.event_types.length === 0
      ? 'off'
      : row.events_url
        ? 'http'
        : 'gateway';
  return { interactions, events };
}

function toBot(row: {
  id: string;
  display_name: string;
  avatar_url: string | null;
  bot_owner_id: string | null;
  scopes: string[];
  interactions_url: string | null;
  events_url: string | null;
  event_types: string[];
  created_at: Date;
  last_used_at: Date | null;
}): Bot {
  return {
    id: row.id,
    name: row.display_name,
    avatarUrl: row.avatar_url,
    ownerId: row.bot_owner_id ?? '',
    scopes: row.scopes as BotScope[],
    interactionsUrl: row.interactions_url,
    eventsUrl: row.events_url,
    eventTypes: row.event_types as EventType[],
    delivery: deliveryModes(row),
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  };
}
