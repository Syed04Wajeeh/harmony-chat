import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Older clients sent their automatic idle as the chosen status, so nearly every stored 'idle'
  // is stale. Automatic idleness is now per connection and never stored. Someone who really
  // chose idle loses that choice once and picks it again.
  await sql`update users set status = 'online' where status = 'idle'`.execute(db);
}

export async function down(): Promise<void> {
  // Which idle values were deliberate is not recoverable, and restoring them would only bring
  // back the stuck-idle accounts.
}
