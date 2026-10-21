import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Content may be empty when a message carries attachments; the service enforces that rule.
  await sql`alter table messages drop constraint messages_content_check`.execute(db);
  await sql`
    alter table messages
      add constraint messages_content_check check (char_length(content) <= 4000),
      add column reply_to_id bigint references messages (id) on delete set null,
      add column pinned_at timestamptz,
      add column pinned_by bigint references users (id) on delete set null,
      add column search tsvector generated always as (to_tsvector('simple', content)) stored
  `.execute(db);

  await sql`create index messages_search_idx on messages using gin (search)`.execute(db);
  await sql`
    create index messages_reply_to_idx on messages (reply_to_id) where reply_to_id is not null
  `.execute(db);
  await sql`
    create index messages_pinned_idx on messages (channel_id, pinned_at desc)
    where pinned_at is not null
  `.execute(db);

  await sql`
    create table message_reactions (
      message_id bigint not null references messages (id) on delete cascade,
      user_id bigint not null references users (id) on delete cascade,
      emoji text not null,
      created_at timestamptz not null default now(),
      primary key (message_id, user_id, emoji)
    )
  `.execute(db);

  await sql`
    create table message_mentions (
      message_id bigint not null references messages (id) on delete cascade,
      user_id bigint not null references users (id) on delete cascade,
      primary key (message_id, user_id)
    )
  `.execute(db);
  // Serves the per-channel mention count: "my mentions after message X".
  await sql`create index message_mentions_user_message_idx on message_mentions (user_id, message_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table message_mentions`.execute(db);
  await sql`drop table message_reactions`.execute(db);
  await sql`
    alter table messages
      drop column search,
      drop column pinned_by,
      drop column pinned_at,
      drop column reply_to_id,
      drop constraint messages_content_check
  `.execute(db);
  await sql`delete from messages where content = ''`.execute(db);
  await sql`
    alter table messages add constraint messages_content_check
      check (char_length(content) between 1 and 4000)
  `.execute(db);
}
