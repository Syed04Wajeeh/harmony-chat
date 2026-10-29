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
import type { GatewayBus } from '../gateway/bus.js';
import { eventFrame } from '../gateway/events.js';
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
  bot_id: string;
  /** Set for gateway deliveries: the bot's event sequence number. */
  seq: string | null;
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
  | 'GATEWAY_ACK_TIMEOUT_MS'
  | 'GATEWAY_EVENT_TTL_MS'
  | 'GATEWAY_BACKLOG_MAX'
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
  /**
   * When set, only deliveries to these bots are claimed. A seam for tests that share one
   * database with other workers; production workers claim everything.
   */
  claimOnly: string[] | null = null;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: WorkerOptions,
    private readonly log: WorkerLogger,
    private readonly random: () => number = Math.random,
    private readonly onTick: () => void = () => undefined,
    /** Without it, deliveries for gateway bots are left alone (nothing could carry them). */
    private readonly gateway: GatewayBus | null = null,
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

  /**
   * Creates delivery rows for a batch of outbox events; returns how many events it handled.
   * Bots with an events URL get plain rows. Bots without one are gateway bots: their rows carry a
   * per-bot sequence number, handed out under a lock on the bot's row so that numbers follow
   * commit order (the bot may treat "acknowledged up to N" as everything before N).
   */
  async fanOut(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const { rows: batch } = await sql<{ id: string }>`
        select id from event_outbox
        where fanned_out_at is null
        order by id
        limit ${this.options.DELIVERY_BATCH_SIZE * 5}
        for update skip locked
      `.execute(trx);
      if (batch.length === 0) return 0;
      const ids = batch.map((row) => row.id);

      const { rows: pairs } = await sql<{ event_id: string; bot_id: string; gateway: boolean }>`
        select b.id as event_id, bots.user_id as bot_id, (bots.events_url is null) as gateway
        from event_outbox b
        join guild_members gm on gm.guild_id = b.guild_id
        join bots on bots.user_id = gm.user_id
        where b.id = any(${ids}::bigint[])
          and 'events' = any(bots.scopes)
          and b.type = any(bots.event_types)
          and (b.type not like 'message.%' and b.type not like 'reaction.%'
               or 'messages.read' = any(bots.scopes))
          and (b.channel_id is null or exists (
            select 1 from channel_members cm
            where cm.channel_id = b.channel_id and cm.user_id = bots.user_id))
      `.execute(trx);

      const http = pairs.filter((pair) => !pair.gateway);
      if (http.length > 0) {
        await sql`
          insert into event_deliveries (event_id, bot_id)
          select * from unnest(${http.map((p) => p.event_id)}::bigint[],
                               ${http.map((p) => p.bot_id)}::bigint[])
          on conflict (event_id, bot_id) do nothing
        `.execute(trx);
      }
      const gateway = pairs.filter((pair) => pair.gateway);
      if (gateway.length > 0) {
        const eventIds = gateway.map((p) => p.event_id);
        const botIds = gateway.map((p) => p.bot_id);
        // Lock in id order so two workers fanning out for the same bots cannot deadlock.
        const locked = [...new Set(botIds)].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
        await sql`
          select user_id from bots where user_id = any(${locked}::bigint[])
          order by user_id for update
        `.execute(trx);
        await sql`
          insert into event_deliveries (event_id, bot_id, seq)
          select p.event_id, p.bot_id,
                 b.event_seq + row_number() over (partition by p.bot_id order by p.event_id)
          from unnest(${eventIds}::bigint[], ${botIds}::bigint[]) as p(event_id, bot_id)
          join bots b on b.user_id = p.bot_id
          on conflict (event_id, bot_id) do nothing
        `.execute(trx);
        await sql`
          update bots set event_seq = event_seq + c.n
          from (select bot_id, count(*) as n
                from unnest(${eventIds}::bigint[], ${botIds}::bigint[]) as p(event_id, bot_id)
                group by bot_id) c
          where bots.user_id = c.bot_id
        `.execute(trx);
      }
      await sql`update event_outbox set fanned_out_at = now() where id = any(${ids}::bigint[])`.execute(
        trx,
      );
      return batch.length;
    });
  }

  /** Claims due deliveries under a lease and delivers them; returns how many it claimed. */
  async deliverDue(): Promise<number> {
    // Gateway deliveries are only claimed while their bot is connected somewhere, so a bot that is
    // offline does not burn attempts; its backlog waits (until the TTL dead-letters it).
    const online = this.gateway ? await this.gateway.onlineBots() : [];
    const { rows } = await sql<Claimed>`
      with claimed as (
        update event_deliveries set
          attempts = attempts + 1,
          next_attempt_at = now() + ${this.options.DELIVERY_LEASE_MS} * interval '1 millisecond'
        where id in (
          select id from event_deliveries
          where status in ('pending', 'failed') and next_attempt_at <= now()
            and (seq is null or bot_id = any(${online}::bigint[]))
            and (${this.claimOnly}::bigint[] is null or bot_id = any(${this.claimOnly}::bigint[]))
          order by next_attempt_at, id
          limit ${this.options.DELIVERY_BATCH_SIZE}
          for update skip locked
        )
        returning id, event_id, bot_id, attempts, seq
      )
      select c.id, c.event_id, c.attempts, c.bot_id, c.seq, e.type, e.guild_id, e.payload,
             e.created_at as event_created_at,
             b.events_url, b.signing_secret, owner.is_admin as owner_is_admin
      from claimed c
      join event_outbox e on e.id = c.event_id
      join bots b on b.user_id = c.bot_id
      join users bu on bu.id = b.user_id
      left join users owner on owner.id = bu.bot_owner_id
    `.execute(this.db);
    const gateway = rows
      .filter((row) => row.seq !== null)
      .sort((x, y) =>
        x.bot_id === y.bot_id ? Number(x.seq) - Number(y.seq) : x.bot_id < y.bot_id ? -1 : 1,
      );
    await Promise.all([
      ...rows.filter((row) => row.seq === null).map((row) => this.deliver(row)),
      // In order within a bot, so the frames of one batch arrive in sequence.
      this.deliverToGateway(gateway),
    ]);
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
    await this.deadLetterGateway();
    await sql`delete from interactions where expires_at < now() - interval '1 day'`.execute(
      this.db,
    );
    this.log.info(
      { deliveries: Number(succeeded.numAffectedRows), events: Number(events.numAffectedRows) },
      'retention pass',
    );
  }

  /**
   * Gateway events nobody acknowledged in time or beyond the per-bot backlog limit go to the
   * dead-letter state, as an HTTP delivery does after its last attempt.
   */
  async deadLetterGateway(): Promise<void> {
    await sql`
      update event_deliveries
      set status = 'dead', last_error = 'not acknowledged within the retention window'
      where seq is not null and status in ('pending', 'failed')
        and created_at < now() - ${this.options.GATEWAY_EVENT_TTL_MS} * interval '1 millisecond'
    `.execute(this.db);
    await sql`
      update event_deliveries
      set status = 'dead', last_error = 'backlog limit exceeded'
      where id in (
        select id from (
          select id, row_number() over (partition by bot_id order by seq desc) as position
          from event_deliveries
          where seq is not null and status in ('pending', 'failed')
        ) ranked
        where position > ${this.options.GATEWAY_BACKLOG_MAX}
      )
    `.execute(this.db);
  }

  private async deliverToGateway(rows: Claimed[]): Promise<void> {
    const gateway = this.gateway;
    for (const row of rows) {
      if (row.attempts > this.options.DELIVERY_MAX_ATTEMPTS) {
        await this.finish(row, 'dead', null, 'not acknowledged after repeated sends');
        continue;
      }
      let delivered = 0;
      try {
        const connectionId = await gateway?.pick(row.bot_id);
        if (gateway && connectionId) {
          delivered = await gateway.publish(
            connectionId,
            eventFrame({
              delivery_id: row.id,
              seq: row.seq ?? '0',
              event_id: row.event_id,
              type: row.type,
              guild_id: row.guild_id,
              payload: row.payload,
              event_created_at: row.event_created_at,
            }),
          );
        }
      } catch (error) {
        this.log.warn({ err: error }, 'gateway publish failed');
      }
      if (delivered > 0) {
        // Stays open until the bot acknowledges; if it does not, the next claim sends it again.
        await sql`
          update event_deliveries
          set next_attempt_at = now() + ${this.options.GATEWAY_ACK_TIMEOUT_MS} * interval '1 millisecond'
          where id = ${row.id}
        `.execute(this.db);
      } else {
        // The bot vanished between the presence check and the publish: not an attempt.
        await sql`
          update event_deliveries
          set attempts = attempts - 1, next_attempt_at = now() + interval '1 second'
          where id = ${row.id}
        `.execute(this.db);
      }
    }
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
