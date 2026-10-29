import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '../../src/db.js';
import { createMigrator, migrateAll } from '../../src/migrator.js';
import { modules } from '../../src/modules/index.js';

const admin = new pg.Pool({ connectionString: inject('databaseUrl'), max: 1 });
const created: string[] = [];

/** A new empty database on the shared Postgres. */
async function freshDb() {
  const name = `mig_${randomBytes(4).toString('hex')}`;
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

const tables = async (db: Awaited<ReturnType<typeof freshDb>>) =>
  (
    await sql<{ table_name: string }>`
      select table_name from information_schema.tables where table_schema = 'public'
    `.execute(db)
  ).rows.map((row) => row.table_name);

describe('migrations', () => {
  it('build the whole schema from scratch, core first and each module in its own history', async () => {
    const db = await freshDb();
    const { error, results } = await migrateAll(db, modules);
    expect(error).toBeUndefined();
    const names = (results ?? []).map((r) => r.migrationName);
    expect(names.indexOf('0014_modules')).toBeGreaterThan(names.indexOf('0013_event_outbox'));
    expect(names).toContain('polls:0001_polls');
    expect(
      names.every(
        (name) => (results ?? []).find((r) => r.migrationName === name)?.status === 'Success',
      ),
    ).toBe(true);

    const present = await tables(db);
    expect(present).toEqual(
      expect.arrayContaining([
        'guild_modules',
        'polls',
        'poll_options',
        'poll_votes',
        'kysely_migration',
        'harmony_module_polls_migration',
      ]),
    );

    // Nothing left to do the second time.
    const again = await migrateAll(db, modules);
    expect(again.error).toBeUndefined();
    expect(again.results).toEqual([]);
    await db.destroy();
  });

  it('upgrade a database at the previous schema without touching what is there', async () => {
    const db = await freshDb();
    const core = createMigrator(db);
    const before = await core.migrateTo('0013_event_outbox');
    expect(before.error).toBeUndefined();

    const user = await sql<{ id: string }>`
      insert into users (login, display_name) values ('ada@example.com', 'Ada') returning id
    `.execute(db);
    const userId = user.rows[0]?.id ?? '';
    const guild = await sql<{ id: string }>`
      insert into guilds (name, owner_id) values ('Book club', ${userId}) returning id
    `.execute(db);
    const channel = await sql<{ id: string }>`
      insert into channels (guild_id, name, created_by) values (${guild.rows[0]?.id ?? ''}, 'general', ${userId})
      returning id
    `.execute(db);
    await sql`
      insert into messages (channel_id, author_id, content)
      values (${channel.rows[0]?.id ?? ''}, ${userId}, 'written before modules existed')
    `.execute(db);
    const applied = await db
      .selectFrom('kysely_migration' as never)
      .selectAll()
      .execute();

    const { error } = await migrateAll(db, modules);
    expect(error).toBeUndefined();

    // Core history: the thirteen rows are exactly as they were, and one was added.
    const after = await db
      .selectFrom('kysely_migration' as never)
      .selectAll()
      .execute();
    expect(after.slice(0, applied.length)).toEqual(applied);
    expect(after.map((row) => (row as { name: string }).name)).toContain('0014_modules');

    const old = await sql<{
      content: string;
      modules: string[];
    }>`select content, modules from messages`.execute(db);
    expect(old.rows).toEqual([{ content: 'written before modules existed', modules: [] }]);
    await db.destroy();
  });

  it('do not mind a module disappearing from the build', async () => {
    const db = await freshDb();
    await migrateAll(db, modules);
    const withoutPolls = modules.filter((module) => module.id !== 'polls');
    const { error, results } = await migrateAll(db, withoutPolls);
    expect(error).toBeUndefined();
    expect(results).toEqual([]);
    expect(await tables(db)).toContain('polls');
    await db.destroy();
  });

  it('can be undone: down() removes what up() added', async () => {
    const db = await freshDb();
    await migrateAll(db, modules);
    const botChannels = await createMigrator(db).migrateDown();
    expect(botChannels.error).toBeUndefined();
    expect(await tables(db)).not.toEqual(expect.arrayContaining(['channel_bots']));
    expect(await tables(db)).not.toContain('bot_schedules');
    const channelColumns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_name = 'channels'
    `.execute(db);
    expect(channelColumns.rows.map((row) => row.column_name)).not.toContain('bot_feed');
    // 0022 only resets stored statuses, so there is nothing to see; step over it.
    expect((await createMigrator(db).migrateDown()).error).toBeUndefined();
    const formats = await createMigrator(db).migrateDown();
    expect(formats.error).toBeUndefined();
    const webhookColumns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_name = 'webhooks'
    `.execute(db);
    expect(webhookColumns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(['format']),
    );
    const gateway = await createMigrator(db).migrateDown();
    expect(gateway.error).toBeUndefined();
    const deliveryColumns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_name = 'event_deliveries'
    `.execute(db);
    expect(deliveryColumns.rows.map((row) => row.column_name)).not.toContain('seq');
    const panels = await createMigrator(db).migrateDown();
    expect(panels.error).toBeUndefined();
    expect(await tables(db)).not.toContain('panels');
    // 0018 only resets a flag, so there is nothing to see; step over it.
    expect((await createMigrator(db).migrateDown()).error).toBeUndefined();
    const profiles = await createMigrator(db).migrateDown();
    expect(profiles.error).toBeUndefined();
    expect(await tables(db)).not.toEqual(
      expect.arrayContaining(['user_profiles', 'guild_emoji', 'user_perks']),
    );
    const customization = await createMigrator(db).migrateDown();
    expect(customization.error).toBeUndefined();
    expect(await tables(db)).not.toEqual(expect.arrayContaining(['user_settings', 'user_themes']));
    const roles = await createMigrator(db).migrateDown();
    expect(roles.error).toBeUndefined();
    expect(await tables(db)).not.toEqual(expect.arrayContaining(['roles', 'channel_overwrites']));
    const down = await createMigrator(db).migrateDown();
    expect(down.error).toBeUndefined();
    expect(await tables(db)).not.toContain('guild_modules');
    const { rows } = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_name = 'messages'
    `.execute(db);
    expect(rows.map((row) => row.column_name)).not.toContain('modules');
    await db.destroy();
  });
});
