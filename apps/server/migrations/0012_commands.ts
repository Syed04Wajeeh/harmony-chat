import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table bot_commands (
      id bigint generated always as identity primary key,
      bot_id bigint not null references bots (user_id) on delete cascade,
      guild_id bigint not null references guilds (id) on delete cascade,
      name text not null check (name ~ '^[a-z0-9-]{1,32}$'),
      description text not null,
      options jsonb not null default '[]',
      created_at timestamptz not null default now(),
      -- One owner per name in a guild, so "/roll" is never ambiguous.
      unique (guild_id, name)
    )
  `.execute(db);
  await sql`create index bot_commands_bot_guild_idx on bot_commands (bot_id, guild_id)`.execute(db);

  await sql`
    create table interactions (
      id bigint generated always as identity primary key,
      token_hash bytea not null,
      bot_id bigint not null references bots (user_id) on delete cascade,
      user_id bigint not null references users (id),
      channel_id bigint not null references channels (id) on delete cascade,
      command_name text not null,
      options jsonb not null default '{}',
      nonce text,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    )
  `.execute(db);
  await sql`create index interactions_expires_at_idx on interactions (expires_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table interactions`.execute(db);
  await sql`drop table bot_commands`.execute(db);
}
