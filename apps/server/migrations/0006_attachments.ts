import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table attachments (
      id uuid primary key default gen_random_uuid(),
      uploader_id bigint not null references users (id),
      message_id bigint references messages (id) on delete cascade,
      filename text not null,
      content_type text not null,
      size_bytes bigint not null,
      sha256 text not null,
      storage_key text not null unique,
      width integer,
      height integer,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index attachments_message_id_idx on attachments (message_id) where message_id is not null`.execute(
    db,
  );
  // The orphan sweep scans unattached rows by age.
  await sql`create index attachments_orphans_idx on attachments (created_at) where message_id is null`.execute(
    db,
  );
  await sql`
    alter table guilds add constraint guilds_icon_attachment_id_fkey
      foreign key (icon_attachment_id) references attachments (id) on delete set null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table guilds drop constraint guilds_icon_attachment_id_fkey`.execute(db);
  await sql`drop table attachments`.execute(db);
}
