import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // `avatar_url` stays the picture everyone sees; the provider's own picture is kept apart so an
  // uploaded avatar survives the next sign-in and can be reset.
  await sql`
    alter table users
      add column provider_avatar_url text,
      add column avatar_overridden boolean not null default false
  `.execute(db);
  await sql`update users set provider_avatar_url = avatar_url`.execute(db);

  await sql`
    create table user_profiles (
      user_id bigint primary key references users (id) on delete cascade,
      avatar_attachment_id uuid references attachments (id) on delete set null,
      banner_attachment_id uuid references attachments (id) on delete set null,
      banner_color integer check (banner_color between 0 and 16777215),
      accent_color integer check (accent_color between 0 and 16777215),
      bio text check (char_length(bio) <= 190),
      pronouns text check (char_length(pronouns) <= 40),
      status_emoji text check (char_length(status_emoji) <= 64),
      status_text text check (char_length(status_text) <= 128),
      status_expires_at timestamptz,
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index user_profiles_status_expiry_idx on user_profiles (status_expires_at)
      where status_expires_at is not null
  `.execute(db);

  await sql`
    create table guild_emoji (
      id bigint generated always as identity primary key,
      guild_id bigint not null references guilds (id) on delete cascade,
      name text not null check (name ~ '^[a-z0-9_]{2,32}$'),
      attachment_id uuid not null references attachments (id),
      animated boolean not null default false,
      created_by bigint references users (id) on delete set null,
      created_at timestamptz not null default now(),
      unique (guild_id, name)
    )
  `.execute(db);
  await sql`create index guild_emoji_attachment_idx on guild_emoji (attachment_id)`.execute(db);

  await sql`
    create table user_perks (
      user_id bigint not null references users (id) on delete cascade,
      perk text not null,
      granted_by bigint references users (id) on delete set null,
      granted_at timestamptz not null default now(),
      primary key (user_id, perk)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table user_perks`.execute(db);
  await sql`drop table guild_emoji`.execute(db);
  await sql`drop table user_profiles`.execute(db);
  await sql`alter table users drop column avatar_overridden, drop column provider_avatar_url`.execute(
    db,
  );
}
