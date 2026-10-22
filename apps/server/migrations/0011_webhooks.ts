import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table webhooks (
      id bigint generated always as identity primary key,
      channel_id bigint not null references channels (id) on delete cascade,
      name text not null,
      avatar_attachment_id uuid references attachments (id) on delete set null,
      token_hash bytea not null,
      -- The bot-kind user that authors this webhook's messages.
      user_id bigint not null references users (id),
      created_by bigint not null references users (id),
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index webhooks_channel_id_idx on webhooks (channel_id)`.execute(db);

  await sql`
    alter table messages
      add column webhook_id bigint references webhooks (id) on delete set null,
      add column display_name_override text,
      add column avatar_url_override text,
      add column embeds jsonb not null default '[]'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table messages
      drop column embeds,
      drop column avatar_url_override,
      drop column display_name_override,
      drop column webhook_id
  `.execute(db);
  await sql`drop table webhooks`.execute(db);
}
