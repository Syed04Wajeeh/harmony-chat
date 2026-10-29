import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Feed mode lives on the channel row on purpose: the send path already loads that row, so
  // enforcing it costs no statement.
  await sql`alter table channels add column bot_feed boolean not null default false`.execute(db);

  await sql`
    create table channel_bots (
      channel_id bigint not null references channels (id) on delete cascade,
      bot_id bigint not null references bots (user_id) on delete cascade,
      position integer not null default 0,
      created_at timestamptz not null default now(),
      primary key (channel_id, bot_id)
    )
  `.execute(db);
  await sql`create index channel_bots_bot_idx on channel_bots (bot_id)`.execute(db);

  await sql`
    create table bot_schedules (
      id bigint generated always as identity primary key,
      bot_id bigint not null references bots (user_id) on delete cascade,
      slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
      guild_id bigint not null references guilds (id) on delete cascade,
      channel_id bigint not null references channels (id) on delete cascade,
      every_seconds integer check (every_seconds between 1 and 86400),
      cron text,
      panel_key text check (panel_key ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
      paused boolean not null default false,
      next_run_at timestamptz not null,
      -- Set while a run is in flight; a later claim skips the schedule until it passes.
      pending_until timestamptz,
      last_run_at timestamptz,
      last_status text check (last_status in ('ok', 'failed', 'skipped')),
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (bot_id, slug),
      check ((every_seconds is null) <> (cron is null))
    )
  `.execute(db);
  await sql`
    create index bot_schedules_due_idx on bot_schedules (next_run_at) where not paused
  `.execute(db);
  await sql`create index bot_schedules_channel_idx on bot_schedules (channel_id)`.execute(db);

  // A refresh is an interaction too: same token, deadline and follow-up path.
  await sql`alter table interactions drop constraint interactions_type_check`.execute(db);
  await sql`
    alter table interactions
      add constraint interactions_type_check check (type in ('command', 'action', 'refresh'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from interactions where type = 'refresh'`.execute(db);
  await sql`alter table interactions drop constraint interactions_type_check`.execute(db);
  await sql`
    alter table interactions
      add constraint interactions_type_check check (type in ('command', 'action'))
  `.execute(db);
  await sql`drop table bot_schedules`.execute(db);
  await sql`drop table channel_bots`.execute(db);
  await sql`alter table channels drop column bot_feed`.execute(db);
}
