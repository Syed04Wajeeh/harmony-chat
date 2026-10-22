import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Bots are users: every authorship and membership foreign key keeps working. Their login is a
  // synthetic address on a reserved TLD, so it cannot collide with a Tailscale identity.
  await sql`
    alter table users
      add column kind text not null default 'human' check (kind in ('human', 'bot')),
      add column bot_owner_id bigint references users (id),
      add constraint users_kind_login_check check (
        (kind = 'human' and bot_owner_id is null and login not like '%@bots.harmony.invalid')
        or (kind = 'bot' and login like '%@bots.harmony.invalid')
      )
  `.execute(db);
  await sql`create index users_bot_owner_id_idx on users (bot_owner_id) where bot_owner_id is not null`.execute(
    db,
  );

  await sql`
    create table bots (
      user_id bigint primary key references users (id) on delete cascade,
      token_hash bytea not null,
      signing_secret text not null,
      scopes text[] not null default '{}',
      interactions_url text,
      events_url text,
      event_types text[] not null default '{}',
      created_at timestamptz not null default now(),
      token_rotated_at timestamptz not null default now(),
      last_used_at timestamptz
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table bots`.execute(db);
  await sql`delete from users where kind = 'bot'`.execute(db);
  await sql`
    alter table users
      drop constraint users_kind_login_check,
      drop column bot_owner_id,
      drop column kind
  `.execute(db);
}
