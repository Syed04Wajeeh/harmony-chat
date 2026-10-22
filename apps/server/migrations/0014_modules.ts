import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Per-guild module state. A missing row means "defaults": optional modules are enabled.
  await sql`
    create table guild_modules (
      guild_id bigint not null references guilds (id) on delete cascade,
      module_id text not null,
      enabled boolean not null default true,
      settings jsonb not null default '{}',
      updated_at timestamptz not null default now(),
      primary key (guild_id, module_id)
    )
  `.execute(db);

  // Which modules attached data to a message. A constant default, so adding the column does not
  // rewrite the table, and plain messages keep the empty array.
  await sql`alter table messages add column modules text[] not null default '{}'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table messages drop column modules`.execute(db);
  await sql`drop table guild_modules`.execute(db);
}
