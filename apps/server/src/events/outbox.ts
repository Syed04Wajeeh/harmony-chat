import { sql, type Kysely, type Transaction } from 'kysely';
import type { EventType } from '@harmony/shared';
import type { Database } from '../db/schema.js';

export const OUTBOX_CHANNEL = 'harmony_events';

export interface OutboxEvent {
  guildId: string;
  /** Set for events that happened in a channel; only bots that can read it receive the event. */
  channelId?: string | null;
  type: EventType;
  data: Record<string, unknown>;
}

/**
 * Records an event for outgoing delivery. Call it with the transaction that made the change, so
 * the event exists if and only if the change committed; NOTIFY is queued by the same transaction
 * and only reaches the worker on commit.
 */
export async function enqueueEvent(
  trx: Transaction<Database> | Kysely<Database>,
  event: OutboxEvent,
): Promise<void> {
  // One statement instead of an insert and a separate pg_notify: a round trip saved on every
  // message. NOTIFY is still queued by the surrounding transaction and delivered on commit.
  await sql`
    with inserted as (
      insert into event_outbox (guild_id, channel_id, type, payload)
      values (${event.guildId}, ${event.channelId ?? null}, ${event.type},
              ${JSON.stringify(event.data)}::jsonb)
      returning id
    )
    select pg_notify(${OUTBOX_CHANNEL}, '') from inserted
  `.execute(trx);
}
