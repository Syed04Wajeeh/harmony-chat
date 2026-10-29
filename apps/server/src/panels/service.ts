import { sql, type Kysely, type Selectable } from 'kysely';
import {
  PANEL_LIMITS,
  PanelView,
  appendPoints,
  type AppendPointsBody,
  type DirectoryUser,
  type Panel,
  type PutPanelBody,
} from '@harmony/shared';
import type { ChannelService } from '../channels/service.js';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { PermissionService } from '../permissions/service.js';
import type { RateLimiter } from '../rate-limit.js';
import type { EventBus } from '../realtime/events.js';
import { PanelCoalescer } from './coalescer.js';

type PanelRow = Selectable<Database['panels']>;
type Actor = Pick<DirectoryUser, 'id' | 'isAdmin'>;

export interface PanelLogger {
  warn(obj: object, msg: string): void;
}

export const toPanel = (row: PanelRow): Panel => ({
  id: row.id,
  channelId: row.channel_id,
  botId: row.bot_id,
  key: row.key,
  view: row.view as PanelView,
  version: row.version,
  pinned: row.pinned,
  position: row.position,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const notFound = () => new AppError(404, 'panel_not_found', 'Panel not found');

/**
 * Panels bots publish into channels. Every write bumps `version` in Postgres at once; what is
 * delayed is only the realtime frame, which the coalescer limits to one per panel per window.
 */
export class PanelService {
  private readonly coalescer: PanelCoalescer;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly events: EventBus,
    private readonly channels: ChannelService,
    private readonly perms: PermissionService,
    private readonly limiter: RateLimiter,
    coalesceMs: number,
    private readonly log: PanelLogger,
  ) {
    this.coalescer = new PanelCoalescer({
      windowMs: coalesceMs,
      publish: (panel) => {
        this.events
          .toChannel(panel.channelId, { type: 'panel.updated', channelId: panel.channelId, panel })
          .catch((err: unknown) => this.log.warn({ err }, 'panel publish failed'));
      },
    });
  }

  stop(): void {
    this.coalescer.stop();
  }

  /** Creates or replaces a bot's panel; the key is the bot's own name for it in the channel. */
  async put(bot: DirectoryUser, channelId: string, key: string, body: PutPanelBody) {
    await this.requireBotWrite(bot, channelId);
    const view = JSON.stringify(body.view);
    const row = await this.db.transaction().execute(async (trx) => {
      // One writer per channel at a time, so the panel limit cannot be raced past.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`panels:${channelId}`}, 0))`.execute(
        trx,
      );
      const existing = await trx
        .selectFrom('panels')
        .select('id')
        .where('channel_id', '=', channelId)
        .where('bot_id', '=', bot.id)
        .where('key', '=', key)
        .executeTakeFirst();
      if (existing) {
        return trx
          .updateTable('panels')
          .set({
            view,
            version: sql`version + 1`,
            updated_at: new Date(),
            ...(body.pinned !== undefined && { pinned: body.pinned }),
          })
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const { count, next } = await trx
        .selectFrom('panels')
        .select([
          sql<number>`count(*)::int`.as('count'),
          sql<number>`coalesce(max(position) + 1, 0)::int`.as('next'),
        ])
        .where('channel_id', '=', channelId)
        .executeTakeFirstOrThrow();
      if (count >= PANEL_LIMITS.panelsPerChannel) {
        throw new AppError(
          409,
          'panel_limit',
          `A channel holds at most ${String(PANEL_LIMITS.panelsPerChannel)} panels`,
        );
      }
      return trx
        .insertInto('panels')
        .values({
          channel_id: channelId,
          bot_id: bot.id,
          key,
          view,
          pinned: body.pinned ?? false,
          position: next,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    const panel = toPanel(row);
    this.coalescer.push(panel);
    return panel;
  }

  /** Adds points to a chart block and trims it to its caps. The row is locked, not the pool. */
  async append(bot: DirectoryUser, channelId: string, key: string, body: AppendPointsBody) {
    await this.requireBotWrite(bot, channelId);
    const row = await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('panels')
        .selectAll()
        .where('channel_id', '=', channelId)
        .where('bot_id', '=', bot.id)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw notFound();
      const next = appendPoints(current.view as PanelView, body);
      if (!next) {
        throw new AppError(
          400,
          'invalid_chart',
          'blockId must name a chart block of this panel with room for the series',
        );
      }
      return trx
        .updateTable('panels')
        .set({ view: JSON.stringify(next), version: sql`version + 1`, updated_at: new Date() })
        .where('id', '=', current.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    const panel = toPanel(row);
    this.coalescer.push(panel);
    return panel;
  }

  async removeByKey(bot: DirectoryUser, channelId: string, key: string): Promise<void> {
    await this.requireBotWrite(bot, channelId);
    const row = await this.db
      .deleteFrom('panels')
      .where('channel_id', '=', channelId)
      .where('bot_id', '=', bot.id)
      .where('key', '=', key)
      .returning(['id', 'channel_id'])
      .executeTakeFirst();
    if (!row) throw notFound();
    await this.announceDeleted(row.channel_id, row.id);
  }

  async list(actor: Actor, channelId: string): Promise<Panel[]> {
    await this.channels.requireMember(channelId, actor.id);
    const rows = await this.db
      .selectFrom('panels')
      .selectAll()
      .where('channel_id', '=', channelId)
      .orderBy('position')
      .orderBy('id')
      .execute();
    return rows.map(toPanel);
  }

  /** The panel with its channel, for checks made on behalf of a user clicking a button. */
  async find(panelId: string): Promise<Panel | null> {
    const row = await this.db
      .selectFrom('panels')
      .selectAll()
      .where('id', '=', panelId)
      .executeTakeFirst();
    return row ? toPanel(row) : null;
  }

  /** Someone with `manage_channels` (or the channel's creator) may pin, unpin and delete panels. */
  async setPinned(actor: Actor, panelId: string, pinned: boolean): Promise<Panel> {
    await this.requireManage(actor, panelId);
    const row = await this.db
      .updateTable('panels')
      .set({ pinned, version: sql`version + 1`, updated_at: new Date() })
      .where('id', '=', panelId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw notFound();
    const panel = toPanel(row);
    this.coalescer.push(panel);
    return panel;
  }

  async removeById(actor: Actor, panelId: string): Promise<void> {
    await this.requireManage(actor, panelId);
    const row = await this.db
      .deleteFrom('panels')
      .where('id', '=', panelId)
      .returning(['id', 'channel_id'])
      .executeTakeFirst();
    if (!row) throw notFound();
    await this.announceDeleted(row.channel_id, row.id);
  }

  /** A bot's answer to a button click replaces the panel it owns; no write rate limit applies. */
  async replaceView(botId: string, panelId: string, view: PanelView): Promise<Panel> {
    const row = await this.db
      .updateTable('panels')
      .set({
        view: JSON.stringify(view),
        version: sql`version + 1`,
        updated_at: new Date(),
      })
      .where('id', '=', panelId)
      .where('bot_id', '=', botId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw notFound();
    const panel = toPanel(row);
    this.coalescer.push(panel);
    return panel;
  }

  /** Like `replaceView`, addressed the way a bot names its panels: channel and key. */
  async replaceViewByKey(
    botId: string,
    channelId: string,
    key: string,
    view: PanelView,
  ): Promise<Panel> {
    const row = await this.db
      .updateTable('panels')
      .set({ view: JSON.stringify(view), version: sql`version + 1`, updated_at: new Date() })
      .where('channel_id', '=', channelId)
      .where('bot_id', '=', botId)
      .where('key', '=', key)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw notFound();
    const panel = toPanel(row);
    this.coalescer.push(panel);
    return panel;
  }

  private async announceDeleted(channelId: string, panelId: string): Promise<void> {
    this.coalescer.cancel(panelId);
    await this.events.toChannel(channelId, { type: 'panel.deleted', channelId, panelId });
  }

  private async requireManage(actor: Actor, panelId: string): Promise<void> {
    const target = await this.db
      .selectFrom('panels')
      .innerJoin('channels', 'channels.id', 'panels.channel_id')
      .select(['channels.id as channel_id', 'channels.guild_id', 'channels.created_by'])
      .where('panels.id', '=', panelId)
      .executeTakeFirst();
    if (!target) throw notFound();
    await this.channels.requireMember(target.channel_id, actor.id);
    if (target.created_by === actor.id) return;
    if (!target.guild_id) throw notFound();
    await this.perms.require(actor, target.guild_id, 'manage_channels', target.channel_id);
  }

  /** A bot writes like it sends messages: it must be in the channel and allowed to speak there. */
  private async requireBotWrite(bot: DirectoryUser, channelId: string): Promise<void> {
    if (!bot.isBot) throw new AppError(403, 'bots_only', 'Only bots publish panels');
    const limit = await this.limiter.hit(bot.id);
    if (!limit.allowed) {
      throw new AppError(429, 'rate_limited', 'This bot is updating panels too quickly', {
        'retry-after': String(limit.retryAfterSeconds),
      });
    }
    const channel = await this.channels.requireMember(channelId, bot.id);
    if (!channel.guild_id) {
      throw new AppError(400, 'panels_unavailable', 'Panels only work in guild channels');
    }
    if (channel.archived_at) throw new AppError(409, 'channel_archived', 'Channel is archived');
    await this.perms.require(bot, channel.guild_id, 'send_messages', channelId);
  }
}
