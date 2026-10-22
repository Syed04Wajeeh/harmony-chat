import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import type { EventEnvelope, EventType } from '@harmony/shared';
import {
  DELIVERY_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
} from '@harmony/shared/signature';
import type { WorkerConfig } from '../config.js';
import type { Database } from '../db/schema.js';
import { OutboundError, parseAllowlist, type PrivateAllowlist } from '../outbound/policy.js';
import { safeFetch } from '../outbound/safe-fetch.js';
import { backoffMs } from './backoff.js';
import { OUTBOX_CHANNEL } from './outbox.js';

export interface WorkerLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

interface Claimed {
  id: string;
  event_id: string;
  attempts: number;
  type: string;
  guild_id: string;
  payload: Record<string, unknown>;
  event_created_at: Date;
  events_url: string | null;
  signing_secret: string;
  owner_is_admin: boolean | null;
}

type WorkerOptions = Pick<
  WorkerConfig,
  | 'DATABASE_URL'
  | 'OUTBOUND_PRIVATE_ALLOWLIST'
  | 'WORKER_POLL_MS'
  | 'WORKER_BATCH_WINDOW_MS'
  | 'DELIVERY_TIMEOUT_MS'
  | 'DELIVERY_BACKOFF_BASE_MS'
  | 'DELIVERY_BACKOFF_CAP_MS'
  | 'DELIVERY_MAX_ATTEMPTS'
  | 'DELIVERY_BATCH_SIZE'
  | 'DELIVERY_LEASE_MS'
  | 'EVENT_RETENTION_MS'
  | 'RETENTION_INTERVAL_MS'
>;

/**
 * Drains the transactional outbox: fans each event out to the bots subscribed to it, then
 * delivers the resulting rows over signed HTTP with retries. Any number of workers can run;
 * rows are claimed with `FOR UPDATE SKIP LOCKED`.
 */
export class EventWorker {
  private readonly allowlist: PrivateAllowlist;
  private listener: pg.Client | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private woken = false;
  private wake: (() => void) | undefined;
  private lastPrune = 0;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: WorkerOptions,
    private readonly log: WorkerLogger,
    private readonly random: () => number = Math.random,
    private readonly onTick: () => void = () => undefined,
  ) {
    this.allowlist = parseAllowlist(options.OUTBOUND_PRIVATE_ALLOWLIST);
  }

  async start(): Promise<void> {
    await this.listen();
    this.loop = this.run();
  }

  /** Stops claiming new work and resolves once in-flight deliveries have finished. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.listener?.removeAllListeners();
    await this.listener?.end().catch(() => undefined);
  }

  /** One pass: fan out everything pending, deliver everything due, prune if it is time. */
  async cycle(): Promise<void> {
    while ((await this.fanOut()) > 0 && !this.stopping) {
      // keep going until the outbox is drained
    }
    while (!this.stopping && (await this.deliverDue()) > 0) {
      // keep going until nothing is due
    }
    if (Date.now() - this.lastPrune >= this.options.RETENTION_INTERVAL_MS) {
      this.lastPrune = Date.now();
      await this.prune();
    }
  }

  /** Creates delivery rows for a batch of outbox events; returns how many events it handled. */
  async fanOut(): Promise<number> {
    const { rows } = await sql<{ id: string }>`
      with batch as (
        select id, guild_id, channel_id, type from event_outbox
        where fanned_out_at is null
        order by id
        limit ${this.options.DELIVERY_BATCH_SIZE * 5}
        for update skip locked
      ), inserted as (
        insert into event_deliveries (event_id, bot_id)
        select b.id, bots.user_id
        from batch b
        join guild_members gm on gm.guild_id = b.guild_id
        join bots on bots.user_id = gm.user_id
        where bots.events_url is not null
          and 'events' = any(bots.scopes)
          and b.type = any(bots.event_types)
          and (b.type not like 'message.%' and b.type not like 'reaction.%'
               or 'messages.read' = any(bots.scopes))
          and (b.channel_id is null or exists (
            select 1 from channel_members cm
            where cm.channel_id = b.channel_id and cm.user_id = bots.user_id))
        on conflict (event_id, bot_id) do nothing
        returning 1
      )
      update event_outbox set fanned_out_at = now()
      where id in (select id from batch)
      returning id
    `.execute(this.db);
    return rows.length;
  }

  /** Claims due deliveries under a lease and delivers them; returns how many it claimed. */
  async deliverDue(): Promise<number> {
    const { rows } = await sql<Claimed>`
      with claimed as (
        update event_deliveries set
          attempts = attempts + 1,
          next_attempt_at = now() + ${this.options.DELIVERY_LEASE_MS} * interval '1 millisecond'
        where id in (
          select id from event_deliveries
          where status in ('pending', 'failed') and next_attempt_at <= now()
          order by next_attempt_at, id
          limit ${this.options.DELIVERY_BATCH_SIZE}
          for update skip locked
        )
        returning id, event_id, bot_id, attempts
      )
      select c.id, c.event_id, c.attempts, e.type, e.guild_id, e.payload,
             e.created_at as event_created_at,
             b.events_url, b.signing_secret, owner.is_admin as owner_is_admin
      from claimed c
      join event_outbox e on e.id = c.event_id
      join bots b on b.user_id = c.bot_id
      join users bu on bu.id = b.user_id
      left join users owner on owner.id = bu.bot_owner_id
    `.execute(this.db);
    await Promise.all(rows.map((row) => this.deliver(row)));
    return rows.length;
  }

  async prune(): Promise<void> {
    const retention = this.options.EVENT_RETENTION_MS;
    const cutoff = sql`now() - ${retention} * interval '1 millisecond'`;
    const succeeded = await sql`
      delete from event_deliveries where status = 'succeeded' and delivered_at < ${cutoff}
    `.execute(this.db);
    const events = await sql`delete from event_outbox where created_at < ${cutoff}`.execute(
      this.db,
    );
    await sql`delete from interactions where expires_at < now() - interval '1 day'`.execute(
      this.db,
    );
    this.log.info(
      { deliveries: Number(succeeded.numAffectedRows), events: Number(events.numAffectedRows) },
      'retention pass',
    );
  }

  private async deliver(row: Claimed): Promise<void> {
    if (!row.events_url) return this.finish(row, 'dead', null, 'bot has no events_url');

    const envelope: EventEnvelope = {
      id: row.event_id,
      type: row.type as EventType,
      guildId: row.guild_id,
      createdAt: row.event_created_at.toISOString(),
      data: row.payload,
    };
    const body = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const result = await safeFetch(row.events_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Harmony-Events/1',
          [TIMESTAMP_HEADER]: String(timestamp),
          [SIGNATURE_HEADER]: sign(row.signing_secret, timestamp, body),
          [DELIVERY_ID_HEADER]: row.id,
        },
        body,
        timeoutMs: this.options.DELIVERY_TIMEOUT_MS,
        ownerIsAdmin: row.owner_is_admin ?? false,
        allowlist: this.allowlist,
      });
      if (result.status >= 200 && result.status < 300) {
        return this.finish(row, 'succeeded', result.status, null);
      }
      return this.retryOrBury(row, result.status, `HTTP ${result.status}`);
    } catch (error) {
      const message = error instanceof OutboundError ? `${error.code}: ${error.message}` : 'error';
      const permanent = error instanceof OutboundError && error.code === 'blocked_address';
      if (permanent) return this.finish(row, 'dead', null, message);
      return this.retryOrBury(row, null, message);
    }
  }

  private async retryOrBury(row: Claimed, status: number | null, error: string): Promise<void> {
    if (row.attempts >= this.options.DELIVERY_MAX_ATTEMPTS) {
      return this.finish(row, 'dead', status, error);
    }
    const delay = backoffMs(
      row.attempts,
      this.options.DELIVERY_BACKOFF_BASE_MS,
      this.options.DELIVERY_BACKOFF_CAP_MS,
      this.random,
    );
    await this.db
      .updateTable('event_deliveries')
      .set({
        status: 'failed',
        next_attempt_at: new Date(Date.now() + delay),
        last_status_code: status,
        last_error: error.slice(0, 500),
      })
      .where('id', '=', row.id)
      .execute();
  }

  private async finish(
    row: Claimed,
    status: 'succeeded' | 'dead',
    code: number | null,
    error: string | null,
  ): Promise<void> {
    await this.db
      .updateTable('event_deliveries')
      .set({
        status,
        last_status_code: code,
        last_error: error?.slice(0, 500) ?? null,
        ...(status === 'succeeded' && { delivered_at: new Date() }),
      })
      .where('id', '=', row.id)
      .execute();
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      this.onTick();
      try {
        await this.cycle();
      } catch (err) {
        this.log.error({ err }, 'worker cycle failed');
      }
      if (this.stopping) break;
      await this.sleep();
      // Coalesce: under load every message NOTIFYs, and a pass per notification costs a fan-out
      // query for two or three rows. Waiting briefly turns that into one pass per window.
      const window = this.options.WORKER_BATCH_WINDOW_MS ?? 0;
      if (window > 0 && !this.stopping) await new Promise((r) => setTimeout(r, window));
    }
  }

  private sleep(): Promise<void> {
    if (this.woken) {
      this.woken = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.options.WORKER_POLL_MS);
      this.wake = done;
    });
  }

  /** LISTEN wakes the loop immediately; the poll interval covers a dropped connection. */
  private async listen(): Promise<void> {
    const client = new pg.Client({ connectionString: this.options.DATABASE_URL });
    client.on('notification', () => {
      this.woken = true;
      this.wake?.();
    });
    client.on('error', (err) => {
      this.log.warn({ err }, 'listen connection lost; falling back to polling');
      this.listener = undefined;
      setTimeout(() => {
        if (!this.stopping) void this.listen().catch(() => undefined);
      }, 5000).unref();
    });
    await client.connect();
    await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
    this.listener = client;
  }
}
