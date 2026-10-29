import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // `format` picks how an incoming body becomes a message; `template` is data, never code.
  // The signature secret is plain text like a bot's signing secret: HMAC needs the raw value.
  await sql`
    alter table webhooks
      add column format text not null default 'discord',
      add column template jsonb,
      add column signature_secret text,
      add constraint webhooks_format_check check (
        format in ('discord', 'forgejo', 'github', 'alertmanager', 'grafana', 'watchtower',
                   'generic', 'template')
      ),
      add constraint webhooks_template_check check (format <> 'template' or template is not null)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table webhooks
      drop constraint webhooks_template_check,
      drop constraint webhooks_format_check,
      drop column signature_secret,
      drop column template,
      drop column format
  `.execute(db);
}
