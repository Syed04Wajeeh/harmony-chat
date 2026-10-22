import { sql, type Kysely } from 'kysely';

/** What @everyone gets: the things every guild member could already do before roles existed. */
const EVERYONE = [
  'view_channel',
  'send_messages',
  'attach_files',
  'add_reactions',
  'use_commands',
  'create_channels',
  'create_invites',
  'change_nickname',
  'pins.pin',
  'polls.create',
  'polls.vote',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table roles (
      id bigint generated always as identity primary key,
      guild_id bigint not null references guilds (id) on delete cascade,
      name text not null check (char_length(name) between 1 and 100),
      color integer check (color between 0 and 16777215),
      position integer not null check (position >= 0),
      hoist boolean not null default false,
      mentionable boolean not null default false,
      permissions text[] not null default '{}',
      is_default boolean not null default false,
      created_at timestamptz not null default now(),
      check (not is_default or position = 0)
    )
  `.execute(db);
  await sql`create index roles_guild_id_idx on roles (guild_id)`.execute(db);
  await sql`create unique index roles_one_default_idx on roles (guild_id) where is_default`.execute(
    db,
  );

  await sql`
    alter table guild_members
      add column nickname text check (char_length(nickname) between 1 and 32)
  `.execute(db);

  await sql`
    create table member_roles (
      guild_id bigint not null,
      user_id bigint not null,
      role_id bigint not null references roles (id) on delete cascade,
      primary key (guild_id, user_id, role_id),
      foreign key (guild_id, user_id) references guild_members (guild_id, user_id)
        on delete cascade
    )
  `.execute(db);
  await sql`create index member_roles_role_id_idx on member_roles (role_id)`.execute(db);

  // target_id points at a role or a user depending on target_type, so it has no foreign key;
  // the services delete overwrites when a role or member goes away.
  await sql`
    create table channel_overwrites (
      channel_id bigint not null references channels (id) on delete cascade,
      target_type text not null check (target_type in ('role', 'member')),
      target_id bigint not null,
      allow text[] not null default '{}',
      deny text[] not null default '{}',
      primary key (channel_id, target_type, target_id)
    )
  `.execute(db);

  const everyone = sql.raw(`array[${EVERYONE.map((key) => `'${key}'`).join(', ')}]`);

  // Existing guilds get @everyone with what members could do before.
  await sql`
    insert into roles (guild_id, name, position, permissions, is_default)
    select id, '@everyone', 0, ${everyone}, true from guilds
  `.execute(db);

  // A guild always has its default role, however it was created.
  await sql`
    create function create_default_role() returns trigger language plpgsql as $$
    begin
      insert into roles (guild_id, name, position, permissions, is_default)
      values (new.id, '@everyone', 0, ${everyone}, true);
      return new;
    end $$
  `.execute(db);
  await sql`
    create trigger guilds_default_role after insert on guilds
    for each row execute function create_default_role()
  `.execute(db);

  // A private channel was "visible to the members added to it". Now: @everyone may not view it,
  // and each current member is allowed to.
  await sql`
    insert into channel_overwrites (channel_id, target_type, target_id, allow, deny)
    select c.id, 'role', r.id, '{}', array['view_channel']
    from channels c join roles r on r.guild_id = c.guild_id and r.is_default
    where c.kind = 'text' and c.is_private
  `.execute(db);
  await sql`
    insert into channel_overwrites (channel_id, target_type, target_id, allow, deny)
    select c.id, 'member', cm.user_id, array['view_channel'], '{}'
    from channels c join channel_members cm on cm.channel_id = c.id
    where c.kind = 'text' and c.is_private
  `.execute(db);

  // Owners and instance admins can do everything, so they see every channel. Giving them the
  // rows now keeps channel_members equal to "who can view" without waiting for a later change.
  await sql`
    insert into channel_members (channel_id, user_id, last_read_message_id)
    select c.id, gm.user_id, (select max(m.id) from messages m where m.channel_id = c.id)
    from channels c
    join guilds g on g.id = c.guild_id
    join guild_members gm on gm.guild_id = g.id
    join users u on u.id = gm.user_id
    where c.kind = 'text' and c.is_private and (g.owner_id = gm.user_id or u.is_admin)
    on conflict do nothing
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger guilds_default_role on guilds`.execute(db);
  await sql`drop function create_default_role()`.execute(db);
  await sql`drop table channel_overwrites`.execute(db);
  await sql`drop table member_roles`.execute(db);
  await sql`alter table guild_members drop column nickname`.execute(db);
  await sql`drop table roles`.execute(db);
}
