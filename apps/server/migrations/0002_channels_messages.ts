import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table channels (
      id bigint generated always as identity primary key,
      name text not null unique check (name ~ '^[a-z0-9-]{1,32}$'),
      topic text,
      created_by bigint references users (id),
      created_at timestamptz not null default now()
    )
  `.execute(db);

  await sql`
    create table messages (
      id bigint generated always as identity primary key,
      channel_id bigint not null references channels (id) on delete cascade,
      author_id bigint not null references users (id),
      content text not null check (char_length(content) between 1 and 4000),
      created_at timestamptz not null default now(),
      edited_at timestamptz,
      deleted_at timestamptz
    )
  `.execute(db);

  await sql`create index messages_channel_id_id_idx on messages (channel_id, id desc)`.execute(db);
  await sql`insert into channels (name, topic) values ('general', 'General discussion')`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table messages`.execute(db);
  await sql`drop table channels`.execute(db);
}
