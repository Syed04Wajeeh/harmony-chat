import { sql, type Kysely } from 'kysely';
import type { EventType, GatewayFrame } from '@harmony/shared';
import type { Database } from '../db/schema.js';
import { GATEWAY_ACK_TIMEOUT_MS, type GatewayBus } from './bus.js';

/** Most events a single `resume` replays; the rest follow through the worker's normal retries. */
export const RESUME_BATCH = 500;

export interface EventRow {
  delivery_id: string;
  seq: string;
  event_id: string;
  type: string;
  guild_id: string;
  payload: Record<string, unknown>;
  event_created_at: Date;
}

export function eventFrame(row: EventRow): GatewayFrame {
  return {
    type: 'event',
    seq: Number(row.seq),
    deliveryId: row.delivery_id,
    event: {
      id: row.event_id,
      type: row.type as EventType,
      guildId: row.guild_id,
      createdAt: row.event_created_at.toISOString(),
      data: row.payload,
    },
  };
}

/** Marks every gateway delivery of the bot up to and including `seq` as done. */
export async function ackUpTo(db: Kysely<Database>, botId: string, seq: number): Promise<void> {
  await sql`
    update event_deliveries
    set status = 'succeeded', delivered_at = now(), last_error = null
    where bot_id = ${botId} and seq is not null and seq <= ${seq}
      and status in ('pending', 'failed')
  `.execute(db);
}

/**
 * The bot reconnected and says it has handled everything up to `lastSeq`. Those are acknowledged;
 * the rest that is still open is claimed (so the worker does not send it a second time right
 * away) and published to this connection in order. Returns how many were replayed.
 */
export async function resume(
  db: Kysely<Database>,
  bus: GatewayBus,
  botId: string,
  connectionId: string,
  lastSeq: number,
): Promise<number> {
  await ackUpTo(db, botId, lastSeq);
  const { rows } = await sql<EventRow>`
    with open as (
      select id from event_deliveries
      where bot_id = ${botId} and seq > ${lastSeq} and status in ('pending', 'failed')
      order by seq
      limit ${RESUME_BATCH}
      for update
    ), claimed as (
      update event_deliveries d
      set next_attempt_at = now() + ${GATEWAY_ACK_TIMEOUT_MS} * interval '1 millisecond'
      from open where d.id = open.id
      returning d.id, d.seq, d.event_id
    )
    select c.id as delivery_id, c.seq, e.id as event_id, e.type, e.guild_id, e.payload,
           e.created_at as event_created_at
    from claimed c join event_outbox e on e.id = c.event_id
    order by c.seq
  `.execute(db);
  for (const row of rows) await bus.publish(connectionId, eventFrame(row));
  return rows.length;
}
