import type { Kysely, Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import { BOT_LOGIN_SUFFIX } from '../auth/policy.js';
import type { Database } from '../db/schema.js';

/**
 * Inserts a bot-kind user. The login embeds the id, which only exists after the insert, so the
 * row starts with a unique placeholder and is renamed in the same transaction.
 */
export async function createBotUser(
  trx: Transaction<Database> | Kysely<Database>,
  options: {
    prefix: 'bot' | 'webhook';
    name: string;
    avatarUrl?: string | null;
    ownerId: string | null;
  },
): Promise<string> {
  const row = await trx
    .insertInto('users')
    .values({
      login: `pending-${randomUUID()}${BOT_LOGIN_SUFFIX}`,
      display_name: options.name,
      avatar_url: options.avatarUrl ?? null,
      kind: 'bot',
      bot_owner_id: options.ownerId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .updateTable('users')
    .set({ login: `${options.prefix}-${row.id}${BOT_LOGIN_SUFFIX}` })
    .where('id', '=', row.id)
    .execute();
  return row.id;
}
