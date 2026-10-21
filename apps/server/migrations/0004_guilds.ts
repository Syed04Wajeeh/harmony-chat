import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table guilds (
      id bigint generated always as identity primary key,
      name text not null check (char_length(name) between 1 and 100),
      icon_attachment_id uuid,
      owner_id bigint not null references users (id),
      is_default boolean not null default false,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  // At most one default guild: where newly arriving users land.
  await sql`create unique index guilds_single_default_idx on guilds (is_default) where is_default`.execute(
    db,
  );

  await sql`
    create table guild_members (
      guild_id bigint not null references guilds (id) on delete cascade,
      user_id bigint not null references users (id) on delete cascade,
      joined_at timestamptz not null default now(),
      primary key (guild_id, user_id)
    )
  `.execute(db);
  await sql`create index guild_members_user_id_idx on guild_members (user_id)`.execute(db);

  await sql`
    create table guild_invites (
      code text primary key,
      guild_id bigint not null references guilds (id) on delete cascade,
      created_by bigint not null references users (id) on delete cascade,
      expires_at timestamptz,
      max_uses integer check (max_uses > 0),
      uses integer not null default 0,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index guild_invites_guild_id_idx on guild_invites (guild_id)`.execute(db);

  await sql`alter table channels add column guild_id bigint references guilds (id) on delete cascade`.execute(
    db,
  );

  // Existing data: one default guild owned by the earliest user holds everything so far.
  await sql`
    insert into guilds (name, owner_id, is_default)
    select 'Harmony', min(id), true from users having count(*) > 0
  `.execute(db);
  await sql`
    insert into guild_members (guild_id, user_id)
    select g.id, u.id from guilds g cross join users u where g.is_default
  `.execute(db);
  await sql`
    update channels set guild_id = (select id from guilds where is_default) where kind = 'text'
  `.execute(db);
  // With no users there is no owner yet; the first user to arrive creates the default guild.
  await sql`delete from channels where kind = 'text' and guild_id is null`.execute(db);

  await sql`
    alter table channels
      drop constraint channels_shape_check,
      drop constraint channels_name_key,
      add constraint channels_shape_check check (
        (kind = 'text' and guild_id is not null and name ~ '^[a-z0-9-]{1,32}$' and dm_key is null)
        or (kind = 'dm' and guild_id is null and name is null and dm_key is not null and is_private)
      ),
      add constraint channels_guild_id_name_key unique (guild_id, name)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table channels
      drop constraint channels_shape_check,
      drop constraint channels_guild_id_name_key
  `.execute(db);
  // Names were only unique per guild; keep the first of any duplicates so the global key fits.
  await sql`
    update channels c set name = c.name || '-' || c.id
    where kind = 'text' and exists (
      select 1 from channels o where o.name = c.name and o.kind = 'text' and o.id < c.id
    )
  `.execute(db);
  await sql`
    alter table channels
      add constraint channels_name_key unique (name),
      add constraint channels_shape_check check (
        (kind = 'text' and name ~ '^[a-z0-9-]{1,32}$' and dm_key is null)
        or (kind = 'dm' and name is null and dm_key is not null and is_private)
      ),
      drop column guild_id
  `.execute(db);
  await sql`drop table guild_invites`.execute(db);
  await sql`drop table guild_members`.execute(db);
  await sql`drop table guilds`.execute(db);
}
