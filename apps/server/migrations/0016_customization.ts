import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_settings (
      user_id bigint primary key references users (id) on delete cascade,
      appearance jsonb not null default '{}',
      behavior jsonb not null default '{}',
      version integer not null default 1,
      updated_at timestamptz not null default now()
    )
  `.execute(db);

  await sql`
    create table user_themes (
      id uuid primary key default gen_random_uuid(),
      user_id bigint not null references users (id) on delete cascade,
      name text not null check (char_length(name) between 1 and 40),
      base text not null check (base in ('dark', 'light')),
      tokens jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index user_themes_user_id_idx on user_themes (user_id, created_at)`.execute(db);

  await sql`
    alter table guilds
      add column accent_color integer check (accent_color between 0 and 16777215),
      add column banner_attachment_id uuid references attachments (id) on delete set null,
      add column description text check (char_length(description) <= 300)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table guilds
      drop column description,
      drop column banner_attachment_id,
      drop column accent_color
  `.execute(db);
  await sql`drop table user_themes`.execute(db);
  await sql`drop table user_settings`.execute(db);
}
