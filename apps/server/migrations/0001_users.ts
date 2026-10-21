import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table users (
      id bigint generated always as identity primary key,
      login text not null unique,
      display_name text not null,
      avatar_url text,
      created_at timestamptz not null default now()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table users`.execute(db);
}
