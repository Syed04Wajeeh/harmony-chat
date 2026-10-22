import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/schema.js';
import { enqueueEvent } from '../events/outbox.js';

type Executor = Kysely<Database> | Transaction<Database>;

/**
 * Adds a user to a guild and to every non-private channel in it. channel_members is the access
 * and read-state table, so joining a guild fans out one row per channel; the user starts caught
 * up on existing history. Also queues a `guild.member_joined` outbox event, so call it inside the
 * caller's transaction. Returns false when they were already a member.
 */
export async function addGuildMember(
  db: Executor,
  guildId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await sql<{ user_id: string }>`
    insert into guild_members (guild_id, user_id) values (${guildId}, ${userId})
    on conflict do nothing returning user_id
  `.execute(db);
  if (rows.length === 0) return false;
  await sql`
    insert into channel_members (channel_id, user_id, last_read_message_id)
    select c.id, ${userId}, (select max(m.id) from messages m where m.channel_id = c.id)
    from channels c
    where c.guild_id = ${guildId} and c.kind = 'text' and not c.is_private
    on conflict do nothing
  `.execute(db);
  const user = await db
    .selectFrom('users')
    .select(['id', 'login', 'display_name', 'avatar_url', 'kind'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  await enqueueEvent(db, {
    guildId,
    type: 'guild.member_joined',
    data: {
      user: {
        id: user.id,
        login: user.login,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        ...(user.kind === 'bot' && { isBot: true }),
      },
    },
  });
  return true;
}

/** A guild with its first `general` channel, owned by and containing only `ownerId`. */
export async function createGuildWithGeneral(
  db: Executor,
  name: string,
  ownerId: string,
  isDefault = false,
): Promise<{ guildId: string; channelId: string }> {
  const guild = await db
    .insertInto('guilds')
    .values({ name, owner_id: ownerId, icon_attachment_id: null, is_default: isDefault })
    .returning('id')
    .executeTakeFirstOrThrow();
  const channel = await db
    .insertInto('channels')
    .values({
      guild_id: guild.id,
      name: 'general',
      topic: 'General discussion',
      created_by: ownerId,
      dm_key: null,
      archived_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await addGuildMember(db, guild.id, ownerId);
  return { guildId: guild.id, channelId: channel.id };
}
