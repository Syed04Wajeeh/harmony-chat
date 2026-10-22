import { sql, type Kysely, type Transaction } from 'kysely';
import type { ChannelOverwrite, OverwriteTarget } from '@harmony/shared';
import type { Database } from '../db/schema.js';

type Executor = Kysely<Database> | Transaction<Database>;

export async function putOverwrite(
  db: Executor,
  channelId: string,
  targetType: OverwriteTarget,
  targetId: string,
  allow: readonly string[],
  deny: readonly string[],
): Promise<void> {
  if (allow.length === 0 && deny.length === 0) {
    await removeOverwrite(db, channelId, targetType, targetId);
    return;
  }
  await db
    .insertInto('channel_overwrites')
    .values({
      channel_id: channelId,
      target_type: targetType,
      target_id: targetId,
      allow: [...allow],
      deny: [...deny],
    })
    .onConflict((oc) =>
      oc
        .columns(['channel_id', 'target_type', 'target_id'])
        .doUpdateSet({ allow: [...allow], deny: [...deny] }),
    )
    .execute();
}

export async function removeOverwrite(
  db: Executor,
  channelId: string,
  targetType: OverwriteTarget,
  targetId: string,
): Promise<void> {
  await db
    .deleteFrom('channel_overwrites')
    .where('channel_id', '=', channelId)
    .where('target_type', '=', targetType)
    .where('target_id', '=', targetId)
    .execute();
}

export async function overwritesOf(db: Executor, channelId: string): Promise<ChannelOverwrite[]> {
  const rows = await db
    .selectFrom('channel_overwrites')
    .selectAll()
    .where('channel_id', '=', channelId)
    .orderBy('target_type')
    .orderBy('target_id')
    .execute();
  return rows.map((row) => ({
    channelId: row.channel_id,
    targetType: row.target_type,
    targetId: row.target_id,
    allow: row.allow,
    deny: row.deny,
  }));
}

/** `is_private` mirrors "@everyone is denied view_channel here", the way the UI shows a lock. */
export async function syncPrivacy(db: Executor, channelId: string): Promise<boolean> {
  const { rows } = await sql<{ is_private: boolean }>`
    update channels c set is_private = exists (
      select 1 from channel_overwrites o join roles r on r.id = o.target_id and r.is_default
      where o.channel_id = c.id and o.target_type = 'role' and 'view_channel' = any (o.deny)
    )
    where c.id = ${channelId} and c.kind = 'text'
    returning c.is_private
  `.execute(db);
  return rows[0]?.is_private ?? false;
}
