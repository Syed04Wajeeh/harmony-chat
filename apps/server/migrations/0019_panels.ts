import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Dashboard channels are text channels that show bot panels; they follow the same naming and
  // access rules, so only the allowed kinds change.
  await sql`
    alter table channels
      drop constraint channels_kind_check,
      drop constraint channels_shape_check,
      add constraint channels_kind_check check (kind in ('text', 'dm', 'dashboard')),
      add constraint channels_shape_check check (
        (kind in ('text', 'dashboard') and guild_id is not null and name ~ '^[a-z0-9-]{1,32}$' and dm_key is null)
        or (kind = 'dm' and guild_id is null and name is null and dm_key is not null and is_private)
      )
  `.execute(db);

  await sql`
    create table panels (
      id bigint generated always as identity primary key,
      channel_id bigint not null references channels (id) on delete cascade,
      bot_id bigint not null references users (id) on delete cascade,
      key text not null check (key ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
      view jsonb not null,
      version integer not null default 1,
      pinned boolean not null default false,
      position integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (channel_id, bot_id, key)
    )
  `.execute(db);
  await sql`create index panels_channel_idx on panels (channel_id, position, id)`.execute(db);

  // Buttons a bot attached to a message; null for every message that has none.
  await sql`alter table messages add column components jsonb`.execute(db);

  // A button click is an interaction too: same token, deadline and follow-up path as a command.
  await sql`
    alter table interactions
      add column type text not null default 'command' check (type in ('command', 'action')),
      add column action_id text,
      add column panel_id bigint references panels (id) on delete set null,
      add column message_id bigint references messages (id) on delete set null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table interactions
      drop column message_id,
      drop column panel_id,
      drop column action_id,
      drop column type
  `.execute(db);
  await sql`alter table messages drop column components`.execute(db);
  await sql`drop table panels`.execute(db);
  await sql`delete from channels where kind = 'dashboard'`.execute(db);
  await sql`
    alter table channels
      drop constraint channels_shape_check,
      drop constraint channels_kind_check,
      add constraint channels_kind_check check (kind in ('text', 'dm')),
      add constraint channels_shape_check check (
        (kind = 'text' and guild_id is not null and name ~ '^[a-z0-9-]{1,32}$' and dm_key is null)
        or (kind = 'dm' and guild_id is null and name is null and dm_key is not null and is_private)
      )
  `.execute(db);
}
