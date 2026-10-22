import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { DEFAULT_EVERYONE_PERMISSIONS, hasPermission } from '@harmony/shared';
import { createDb } from '../../src/db.js';
import { createMigrator } from '../../src/migrator.js';
import { loadGuildAccess, permissionsIn } from '../../src/permissions/access.js';

const admin = new pg.Pool({ connectionString: inject('databaseUrl'), max: 1 });
const created: string[] = [];

async function freshDb() {
  const name = `perm_${randomBytes(4).toString('hex')}`;
  await admin.query(`create database ${name}`);
  created.push(name);
  const url = new URL(inject('databaseUrl'));
  url.pathname = `/${name}`;
  return createDb(url.toString());
}

afterAll(async () => {
  for (const name of created) await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
});

const id = async (db: Awaited<ReturnType<typeof freshDb>>, query: ReturnType<typeof sql>) =>
  (await query.execute(db)).rows[0] as { id: string };

describe('the roles migration on a database that has data', () => {
  it('keeps what members could do and who sees which channel', async () => {
    const db = await freshDb();
    const core = createMigrator(db);
    expect((await core.migrateTo('0014_modules')).error).toBeUndefined();

    // The state a real install is in at the previous schema.
    const user = async (login: string, isAdmin = false) =>
      (
        await id(
          db,
          sql`insert into users (login, display_name, is_admin) values (${login}, ${login}, ${isAdmin}) returning id`,
        )
      ).id;
    const instanceAdmin = await user('admin@example.com', true);
    const owner = await user('owner@example.com');
    const alice = await user('alice@example.com');
    const bob = await user('bob@example.com');
    const outsider = await user('outsider@example.com');
    const { id: guild } = await id(
      db,
      sql`insert into guilds (name, owner_id) values ('Book club', ${owner}) returning id`,
    );
    const { id: other } = await id(
      db,
      sql`insert into guilds (name, owner_id) values ('Other', ${outsider}) returning id`,
    );
    for (const u of [instanceAdmin, owner, alice, bob]) {
      await sql`insert into guild_members (guild_id, user_id) values (${guild}, ${u})`.execute(db);
    }
    await sql`insert into guild_members (guild_id, user_id) values (${other}, ${outsider})`.execute(
      db,
    );

    const channel = async (name: string, isPrivate: boolean, createdBy: string, guildId = guild) =>
      (
        await id(
          db,
          sql`insert into channels (guild_id, name, is_private, created_by)
              values (${guildId}, ${name}, ${isPrivate}, ${createdBy}) returning id`,
        )
      ).id;
    const general = await channel('general', false, owner);
    const secret = await channel('secret', true, alice);
    const duo = await channel('duo', true, alice);
    await channel('elsewhere', false, outsider, other);

    const members: Record<string, string[]> = {
      [general]: [instanceAdmin, owner, alice, bob],
      [secret]: [alice, bob],
      [duo]: [alice],
    };
    for (const [channelId, users] of Object.entries(members)) {
      for (const u of users) {
        await sql`insert into channel_members (channel_id, user_id) values (${channelId}, ${u})`.execute(
          db,
        );
      }
    }
    await sql`insert into messages (channel_id, author_id, content) values (${secret}, ${alice}, 'old news')`.execute(
      db,
    );
    const lastMessage = (await sql<{ id: string }>`select max(id) as id from messages`.execute(db))
      .rows[0]?.id;

    expect((await core.migrateToLatest()).error).toBeUndefined();

    // @everyone exists once per guild with the documented permissions.
    const defaults = await sql<{ guild_id: string; permissions: string[] }>`
      select guild_id, permissions from roles where is_default
    `.execute(db);
    expect(defaults.rows).toHaveLength(2);
    for (const row of defaults.rows) {
      expect([...row.permissions].sort()).toEqual([...DEFAULT_EVERYONE_PERMISSIONS].sort());
    }

    // Private channels are private to the people they already had, plus the owner and the
    // instance admin, who can see everything now.
    const inChannel = async (channelId: string) =>
      (
        await sql<{
          user_id: string;
        }>`select user_id from channel_members where channel_id = ${channelId}`.execute(db)
      ).rows
        .map((row) => row.user_id)
        .sort();
    expect(await inChannel(general)).toEqual([instanceAdmin, owner, alice, bob].sort());
    expect(await inChannel(secret)).toEqual([instanceAdmin, owner, alice, bob].sort());
    expect(await inChannel(duo)).toEqual([instanceAdmin, owner, alice].sort());
    expect(await inChannel(duo)).not.toContain(bob);

    const flags = await sql<{ name: string; is_private: boolean }>`
      select name, is_private from channels where guild_id = ${guild} order by name
    `.execute(db);
    expect(flags.rows).toEqual([
      { name: 'duo', is_private: true },
      { name: 'general', is_private: false },
      { name: 'secret', is_private: true },
    ]);

    // The new rows start caught up, so nobody gets an unread storm.
    const added = await sql<{ last_read_message_id: string | null }>`
      select last_read_message_id from channel_members where channel_id = ${secret} and user_id = ${owner}
    `.execute(db);
    expect(added.rows[0]?.last_read_message_id).toBe(lastMessage);

    // The permission model agrees with channel_members for every member and channel.
    const access = await loadGuildAccess(db, guild);
    if (!access) throw new Error('guild missing');
    for (const channelId of [general, secret, duo]) {
      const viewers = [...access.members]
        .filter(([userId, member]) =>
          hasPermission(
            permissionsIn(access, { id: userId, isAdmin: member.isInstanceAdmin }, channelId),
            'view_channel',
          ),
        )
        .map(([userId]) => userId)
        .sort();
      expect(viewers).toEqual(await inChannel(channelId));
    }

    // And what members could do before still works through @everyone.
    for (const key of ['send_messages', 'attach_files', 'create_invites', 'create_channels']) {
      const aliceCan = permissionsIn(access, { id: alice, isAdmin: false }, general);
      expect(hasPermission(aliceCan, key)).toBe(true);
    }
    expect(
      hasPermission(permissionsIn(access, { id: alice, isAdmin: false }), 'manage_guild'),
    ).toBe(false);

    // Down and up again leaves the same result.
    expect((await core.migrateDown()).error).toBeUndefined();
    expect((await core.migrateToLatest()).error).toBeUndefined();
    await db.destroy();
  });
});
