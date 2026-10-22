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
  await trx
    .insertInto('event_outbox')
    .values({
      guild_id: event.guildId,
      channel_id: event.channelId ?? null,
      type: event.type,
      payload: JSON.stringify(event.data),
      fanned_out_at: null,
    })
    .execute();
  await sql`select pg_notify(${OUTBOX_CHANNEL}, '')`.execute(trx);
}
