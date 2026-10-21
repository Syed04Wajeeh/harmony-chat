import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table users
      add column is_admin boolean not null default false,
      add column status text not null default 'online'
        check (status in ('online', 'idle', 'dnd', 'invisible'))
  `.execute(db);
  // The first user ever created is the admin; this covers users that predate the column.
  await sql`update users set is_admin = true where id = (select min(id) from users)`.execute(db);

  await sql`
    alter table channels
      add column kind text not null default 'text' check (kind in ('text', 'dm')),
      add column is_private boolean not null default false,
      add column dm_key text unique,
      add column archived_at timestamptz,
      alter column name drop not null,
      drop constraint channels_name_check,
      add constraint channels_shape_check check (
        (kind = 'text' and name ~ '^[a-z0-9-]{1,32}$' and dm_key is null)
        or (kind = 'dm' and name is null and dm_key is not null and is_private)
      )
  `.execute(db);

  await sql`
    create table channel_members (
      channel_id bigint not null references channels (id) on delete cascade,
      user_id bigint not null references users (id) on delete cascade,
      joined_at timestamptz not null default now(),
      last_read_message_id bigint,
      primary key (channel_id, user_id)
    )
  `.execute(db);
  await sql`create index channel_members_user_id_idx on channel_members (user_id)`.execute(db);

  // Existing users start as members of general, caught up on its history.
  await sql`
    insert into channel_members (channel_id, user_id, last_read_message_id)
    select c.id, u.id, (select max(m.id) from messages m where m.channel_id = c.id)
    from channels c cross join users u
    where c.name = 'general'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table channel_members`.execute(db);
  await sql`delete from channels where kind = 'dm'`.execute(db);
  await sql`
    alter table channels
      drop constraint channels_shape_check,
      drop column archived_at,
      drop column dm_key,
      drop column is_private,
      drop column kind,
      alter column name set not null,
      add constraint channels_name_check check (name ~ '^[a-z0-9-]{1,32}$')
  `.execute(db);
  await sql`alter table users drop column status, drop column is_admin`.execute(db);
}
