import { sql, type Kysely } from 'kysely';
import { nextRunAt } from '@harmony/shared';
import type { Database } from '../db/schema.js';

export interface SchedulerLogger {
  warn(obj: object, msg: string): void;
}

interface Due {
  id: string;
  bot_id: string;
  slug: string;
  guild_id: string;
  channel_id: string;
  every_seconds: number | null;
  cron: string | null;
  panel_key: string | null;
  pending: boolean;
  db_now: Date;
}

export interface RefreshJob {
  botId: string;
  guildId: string;
  channelId: string;
  slug: string;
  panelKey: string | null;
}

export type RefreshOutcome = { ok: true } | { ok: false; error: string };

/**
 * Runs the schedules bots registered. Every app instance runs one; they share the work through
 * the table: a tick claims due rows with `FOR UPDATE SKIP LOCKED` and, in the same short
 * transaction, moves `next_run_at` ahead and marks the row pending, so a second instance finds
 * nothing due and a slow bot never gets a second refresh on top of the first. The delivery itself
 * happens after the transaction, through the interaction pipeline.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly refresh: (job: RefreshJob) => Promise<RefreshOutcome>,
    private readonly options: {
      tickMs: number;
      /** How long a run may stay pending before the schedule is considered free again. */
      pendingMs: number;
      batch?: number;
    },
    private readonly log: SchedulerLogger,
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    if (this.options.tickMs <= 0) return;
    const loop = () => {
      this.timer = setTimeout(() => {
        void this.tick()
          .catch((err: unknown) => this.log.warn({ err }, 'scheduler tick failed'))
          .finally(() => {
            if (!this.stopping) loop();
          });
      }, this.options.tickMs);
      this.timer.unref();
    };
    loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await Promise.allSettled([...this.inflight]);
  }

  /** Claims what is due and delivers it; resolves once those deliveries have finished. */
  async tick(): Promise<number> {
    const runnable = await this.claim();
    const runs = runnable.map((due) => {
      const run = this.run(due).finally(() => this.inflight.delete(run));
      this.inflight.add(run);
      return run;
    });
    await Promise.all(runs);
    return runnable.length;
  }

  private claim(): Promise<Due[]> {
    return this.db.transaction().execute(async (trx) => {
      const { rows } = await sql<Due>`
        select s.id, s.bot_id, s.slug, s.guild_id, s.channel_id, s.every_seconds, s.cron,
               s.panel_key, now() as db_now,
               (s.pending_until is not null and s.pending_until > now()) as pending
        from bot_schedules s
        where not s.paused and s.next_run_at <= now()
        order by s.next_run_at
        limit ${this.options.batch ?? 50}
        for update of s skip locked
      `.execute(trx);
      const runnable: Due[] = [];
      for (const due of rows) {
        let next: Date;
        try {
          next = nextRunAt({ every: due.every_seconds, cron: due.cron }, due.db_now, this.random);
        } catch {
          await sql`
            update bot_schedules
            set paused = true, last_status = 'failed', last_error = 'schedule has no next run'
            where id = ${due.id}
          `.execute(trx);
          continue;
        }
        if (due.pending) {
          await sql`
            update bot_schedules
            set next_run_at = ${next}, last_status = 'skipped',
                last_error = 'previous run still pending'
            where id = ${due.id}
          `.execute(trx);
          continue;
        }
        await sql`
          update bot_schedules
          set next_run_at = ${next},
              pending_until = now() + ${this.options.pendingMs} * interval '1 millisecond'
          where id = ${due.id}
        `.execute(trx);
        runnable.push(due);
      }
      return runnable;
    });
  }

  private async run(due: Due): Promise<void> {
    let outcome: RefreshOutcome;
    try {
      outcome = await this.refresh({
        botId: due.bot_id,
        guildId: due.guild_id,
        channelId: due.channel_id,
        slug: due.slug,
        panelKey: due.panel_key,
      });
    } catch (err) {
      this.log.warn({ err }, 'schedule run threw');
      outcome = { ok: false, error: 'error' };
    }
    await sql`
      update bot_schedules
      set pending_until = null, last_run_at = now(),
          last_status = ${outcome.ok ? 'ok' : 'failed'},
          last_error = ${outcome.ok ? null : outcome.error}
      where id = ${due.id}
    `
      .execute(this.db)
      .catch((err: unknown) => this.log.warn({ err }, 'could not record schedule result'));
  }
}
