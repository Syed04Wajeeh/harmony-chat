import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // `guilds.is_default` now marks the optional "lobby" guild an instance admin picks for
  // newcomers. Until now the first guild kept it and swept every new user into it, so existing
  // installs are reset to "no lobby": an admin opts in again if they still want that behaviour.
  await sql`update guilds set is_default = false where is_default`.execute(db);
}

export async function down(): Promise<void> {
  // Which guild used to be the default is not recoverable and not worth restoring.
}
