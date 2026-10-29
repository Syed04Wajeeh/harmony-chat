import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // How many bot-to-bot replies deep a message is; 0 for everything a person or a webhook wrote.
  await sql`
    alter table messages
      add column hops smallint not null default 0,
      add constraint messages_hops_check check (hops >= 0)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table messages
      drop constraint messages_hops_check,
      drop column hops
  `.execute(db);
}
