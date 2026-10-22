import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // One poll per message; deleting the message row deletes everything below it.
  await sql`
    create table polls (
      message_id bigint primary key references messages (id) on delete cascade,
      multiple boolean not null default false,
      closed_at timestamptz
    )
  `.execute(db);

  await sql`
    create table poll_options (
      id integer not null,
      message_id bigint not null references polls (message_id) on delete cascade,
      label text not null check (char_length(label) between 1 and 100),
      primary key (message_id, id)
    )
  `.execute(db);

  await sql`
    create table poll_votes (
      message_id bigint not null,
      option_id integer not null,
      user_id bigint not null references users (id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (message_id, user_id, option_id),
      foreign key (message_id, option_id) references poll_options (message_id, id) on delete cascade
    )
  `.execute(db);
  await sql`create index poll_votes_option_idx on poll_votes (message_id, option_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table poll_votes`.execute(db);
  await sql`drop table poll_options`.execute(db);
  await sql`drop table polls`.execute(db);
}
