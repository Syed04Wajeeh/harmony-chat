import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Gateway bots receive events as numbered frames. `event_seq` is the last number handed out for
  // a bot; a delivery's `seq` is null for HTTP bots, which have no cursor.
  await sql`alter table bots add column event_seq bigint not null default 0`.execute(db);
  await sql`alter table event_deliveries add column seq bigint`.execute(db);
  await sql`
    create unique index event_deliveries_bot_seq_idx on event_deliveries (bot_id, seq)
      where seq is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index event_deliveries_bot_seq_idx`.execute(db);
  await sql`alter table event_deliveries drop column seq`.execute(db);
  await sql`alter table bots drop column event_seq`.execute(db);
}
