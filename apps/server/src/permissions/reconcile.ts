import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/schema.js';
import { loadGuildAccess, permissionsIn } from './access.js';

type Executor = Kysely<Database> | Transaction<Database>;

export interface AccessChange {
  channelId: string;
  userId: string;
}

export interface AccessDiff {
  added: AccessChange[];
  removed: AccessChange[];
}

/**
 * Makes `channel_members` equal to "members who hold `view_channel`" for the guild's text
 * channels, reading the permission data through `db` so a caller's transaction sees its own
 * changes. New members start caught up on history. `channelIds` and `userIds` narrow the
 * work to what a change can have affected. Returns what changed so the caller can emit events
 * once the transaction commits.
 */
export async function reconcileAccess(
  db: Executor,
  guildId: string,
  scope: { channelIds?: readonly string[]; userIds?: readonly string[] } = {},
): Promise<AccessDiff> {
  const diff: AccessDiff = { added: [], removed: [] };
  const access = await loadGuildAccess(db, guildId);
  if (!access) return diff;

  const channels = (
    await db
      .selectFrom('channels')
      .select('id')
      .where('guild_id', '=', guildId)
      .where('kind', 'in', ['text', 'dashboard'])
      .$if(scope.channelIds !== undefined, (qb) =>
        qb.where('id', 'in', [...(scope.channelIds ?? [])]),
      )
      .execute()
  ).map((row) => row.id);
  const userIds = scope.userIds ?? [...access.members.keys()];
  if (channels.length === 0 || userIds.length === 0) return diff;

  const existing = new Set(
    (
      await db
        .selectFrom('channel_members')
        .select(['channel_id', 'user_id'])
        .where('channel_id', 'in', channels)
        .where('user_id', 'in', [...userIds])
        .execute()
    ).map((row) => `${row.channel_id}:${row.user_id}`),
  );

  for (const channelId of channels) {
    for (const userId of userIds) {
      const member = access.members.get(userId);
      const key = `${channelId}:${userId}`;
      const canView =
        member !== undefined &&
        permissionsIn(access, { id: userId, isAdmin: member.isInstanceAdmin }, channelId);
      const sees = canView && (canView.all || canView.keys.has('view_channel'));
      if (sees && !existing.has(key)) diff.added.push({ channelId, userId });
      else if (!sees && existing.has(key)) diff.removed.push({ channelId, userId });
    }
  }

  for (const [channelId, rows] of groupBy(diff.added)) {
    await sql`
      insert into channel_members (channel_id, user_id, last_read_message_id)
      select ${channelId}, u, (select max(m.id) from messages m where m.channel_id = ${channelId})
      from unnest(${rows}::bigint[]) as u
      on conflict do nothing
    `.execute(db);
  }
  for (const [channelId, rows] of groupBy(diff.removed)) {
    await db
      .deleteFrom('channel_members')
      .where('channel_id', '=', channelId)
      .where('user_id', 'in', rows)
      .execute();
  }
  return diff;
}

function groupBy(changes: AccessChange[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const { channelId, userId } of changes) {
    grouped.set(channelId, [...(grouped.get(channelId) ?? []), userId]);
  }
  return grouped;
}
