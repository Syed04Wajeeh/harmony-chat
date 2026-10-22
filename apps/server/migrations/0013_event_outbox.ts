import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // No foreign key on guild_id: an event row must not block, or be cascaded by, deleting a guild.
  await sql`
    create table event_outbox (
      id bigint generated always as identity primary key,
      guild_id bigint not null,
      channel_id bigint,
      type text not null,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      fanned_out_at timestamptz
    )
  `.execute(db);
  await sql`create index event_outbox_unfanned_idx on event_outbox (id) where fanned_out_at is null`.execute(
    db,
  );
  await sql`create index event_outbox_created_at_idx on event_outbox (created_at)`.execute(db);

  await sql`
    create table event_deliveries (
      id bigint generated always as identity primary key,
      event_id bigint not null references event_outbox (id) on delete cascade,
      bot_id bigint not null references bots (user_id) on delete cascade,
      status text not null default 'pending'
        check (status in ('pending', 'succeeded', 'failed', 'dead')),
      attempts integer not null default 0,
      next_attempt_at timestamptz not null default now(),
      last_status_code integer,
      last_error text,
      created_at timestamptz not null default now(),
      delivered_at timestamptz,
      unique (event_id, bot_id)
    )
  `.execute(db);
  await sql`
    create index event_deliveries_due_idx on event_deliveries (next_attempt_at)
      where status in ('pending', 'failed')
  `.execute(db);
  await sql`create index event_deliveries_bot_idx on event_deliveries (bot_id, id desc)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table event_deliveries`.execute(db);
  await sql`drop table event_outbox`.execute(db);
}
