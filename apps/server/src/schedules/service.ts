import { sql, type Kysely, type Selectable } from 'kysely';
import {
  MAX_SCHEDULES_PER_BOT_PER_GUILD,
  SCHEDULE_MAX_EVERY_SECONDS,
  nextRunAt,
  type DirectoryUser,
  type Schedule,
  type ScheduleEntry,
} from '@harmony/shared';
import type { ChannelService } from '../channels/service.js';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { PermissionService } from '../permissions/service.js';

type Row = Selectable<Database['bot_schedules']>;
type Actor = Pick<DirectoryUser, 'id' | 'isAdmin'>;

const toSchedule = (row: Row): Schedule => ({
  rowId: row.id,
  id: row.slug,
  botId: row.bot_id,
  guildId: row.guild_id,
  channelId: row.channel_id,
  every: row.every_seconds,
  cron: row.cron,
  panelKey: row.panel_key,
  paused: row.paused,
  nextRunAt: row.next_run_at.toISOString(),
  lastRunAt: row.last_run_at?.toISOString() ?? null,
  lastStatus: row.last_status,
  lastError: row.last_error,
});

const notFound = () => new AppError(404, 'schedule_not_found', 'Schedule not found');

/** Schedules bots register for refreshes, and the controls managers have over them. */
export class ScheduleService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly channels: ChannelService,
    private readonly perms: PermissionService,
    private readonly options: { minEverySeconds: number },
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Bulk overwrite, like commands: afterwards the bot's schedules are exactly `entries`. An entry
   * that keeps its cadence keeps its next run and its paused flag, so a bot that registers on every
   * start neither fires early nor undoes a manager's pause.
   */
  async replace(botId: string, entries: readonly ScheduleEntry[]): Promise<Schedule[]> {
    const slugs = new Set<string>();
    for (const entry of entries) {
      if (slugs.has(entry.id)) {
        throw new AppError(400, 'duplicate_schedule', `Schedule "${entry.id}" is listed twice`);
      }
      slugs.add(entry.id);
      if (entry.every !== undefined && entry.every < this.options.minEverySeconds) {
        throw new AppError(
          400,
          'schedule_too_frequent',
          `"every" must be at least ${String(this.options.minEverySeconds)} seconds`,
        );
      }
      if (entry.every !== undefined && entry.every > SCHEDULE_MAX_EVERY_SECONDS) {
        throw new AppError(400, 'invalid_schedule', 'Schedules run at least once a day');
      }
    }

    const channelIds = [...new Set(entries.map((entry) => entry.channelId))];
    const guildOf = new Map<string, string>();
    if (channelIds.length > 0) {
      const rows = await this.db
        .selectFrom('channels as c')
        .innerJoin('channel_members as cm', 'cm.channel_id', 'c.id')
        .select(['c.id', 'c.guild_id'])
        .where('c.id', 'in', channelIds)
        .where('cm.user_id', '=', botId)
        .where('c.guild_id', 'is not', null)
        .where('c.kind', '!=', 'dm')
        .where('c.archived_at', 'is', null)
        .execute();
      for (const row of rows) guildOf.set(row.id, row.guild_id ?? '');
      const missing = channelIds.find((id) => !guildOf.has(id));
      if (missing) {
        throw new AppError(
          409,
          'bot_not_in_channel',
          `The bot cannot see channel ${missing}, or it is archived or a direct message`,
        );
      }
    }
    const perGuild = new Map<string, number>();
    for (const entry of entries) {
      const guildId = guildOf.get(entry.channelId) ?? '';
      perGuild.set(guildId, (perGuild.get(guildId) ?? 0) + 1);
    }
    for (const count of perGuild.values()) {
      if (count > MAX_SCHEDULES_PER_BOT_PER_GUILD) {
        throw new AppError(
          409,
          'schedule_limit',
          `A bot may have at most ${String(MAX_SCHEDULES_PER_BOT_PER_GUILD)} schedules per guild`,
        );
      }
    }

    const rows = await this.db.transaction().execute(async (trx) => {
      // One registration at a time per bot, so the stale-row sweep cannot race an upsert.
      await sql`select user_id from bots where user_id = ${botId} for update`.execute(trx);
      const existing = new Map(
        (
          await trx.selectFrom('bot_schedules').selectAll().where('bot_id', '=', botId).execute()
        ).map((row) => [row.slug, row]),
      );
      const now = new Date();
      for (const entry of entries) {
        const cadence = { every: entry.every ?? null, cron: entry.cron?.trim() ?? null };
        const guildId = guildOf.get(entry.channelId) ?? '';
        const current = existing.get(entry.id);
        const same =
          current?.every_seconds === cadence.every &&
          current?.cron === cadence.cron &&
          current?.channel_id === entry.channelId;
        const values = {
          guild_id: guildId,
          channel_id: entry.channelId,
          every_seconds: cadence.every,
          cron: cadence.cron,
          panel_key: entry.panelKey ?? null,
          updated_at: now,
        };
        if (current) {
          await trx
            .updateTable('bot_schedules')
            .set({ ...values, ...(!same && { next_run_at: nextRunAt(cadence, now, this.random) }) })
            .where('id', '=', current.id)
            .execute();
        } else {
          await trx
            .insertInto('bot_schedules')
            .values({
              bot_id: botId,
              slug: entry.id,
              ...values,
              next_run_at: nextRunAt(cadence, now, this.random),
            })
            .execute();
        }
      }
      const keep = entries.map((entry) => entry.id);
      await trx
        .deleteFrom('bot_schedules')
        .where('bot_id', '=', botId)
        .$if(keep.length > 0, (q) => q.where('slug', 'not in', keep))
        .execute();
      return trx
        .selectFrom('bot_schedules')
        .selectAll()
        .where('bot_id', '=', botId)
        .orderBy('slug')
        .execute();
    });
    return rows.map(toSchedule);
  }

  async listForBot(botId: string): Promise<Schedule[]> {
    const rows = await this.db
      .selectFrom('bot_schedules')
      .selectAll()
      .where('bot_id', '=', botId)
      .orderBy('slug')
      .execute();
    return rows.map(toSchedule);
  }

  /** The schedules aimed at a channel, for people who can manage it. */
  async listForChannel(actor: Actor, channelId: string): Promise<Schedule[]> {
    await this.requireManage(actor, channelId);
    const rows = await this.db
      .selectFrom('bot_schedules')
      .selectAll()
      .where('channel_id', '=', channelId)
      .orderBy('bot_id')
      .orderBy('slug')
      .execute();
    return rows.map(toSchedule);
  }

  async setPaused(actor: Actor, rowId: string, paused: boolean): Promise<Schedule> {
    const row = await this.find(rowId);
    await this.requireManage(actor, row.channel_id);
    const now = new Date();
    const updated = await this.db
      .updateTable('bot_schedules')
      .set({
        paused,
        updated_at: now,
        // A resumed schedule starts a fresh period instead of firing for every missed one.
        ...(!paused && {
          next_run_at: nextRunAt({ every: row.every_seconds, cron: row.cron }, now, this.random),
        }),
      })
      .where('id', '=', rowId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSchedule(updated);
  }

  async remove(actor: Actor, rowId: string): Promise<void> {
    const row = await this.find(rowId);
    await this.requireManage(actor, row.channel_id);
    await this.db.deleteFrom('bot_schedules').where('id', '=', rowId).execute();
  }

  private async find(rowId: string): Promise<Row> {
    const row = await this.db
      .selectFrom('bot_schedules')
      .selectAll()
      .where('id', '=', rowId)
      .executeTakeFirst();
    if (!row) throw notFound();
    return row;
  }

  private async requireManage(actor: Actor, channelId: string): Promise<void> {
    const channel = await this.channels.requireMember(channelId, actor.id);
    if (!channel.guild_id) throw notFound();
    if (channel.created_by === actor.id) return;
    await this.perms.require(actor, channel.guild_id, 'manage_channels', channelId);
  }
}
