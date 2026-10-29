import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Kysely } from 'kysely';
import type { GuildSummary } from '@harmony/shared';
import { createDb } from '../../src/db.js';
import type { Database } from '../../src/db/schema.js';
import { migrateAll } from '../../src/migrator.js';
import { modules } from '../../src/modules/index.js';
import { api, createInfra, type Infra, type TestApp } from './support/harness.js';

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

// Its own database: a lobby guild would otherwise pull the users of every other test file in.
describe('lobby guild', () => {
  let infra: Infra;
  let postgres: StartedPostgreSqlContainer;
  let db: Kysely<Database>;
  let target: TestApp;
  const admin = unique('admin');

  const guildsOf = async (login: string) =>
    ((await api(target, login)('/api/guilds')).body as { guilds: GuildSummary[] }).guilds;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    db = createDb(postgres.getConnectionUri());
    const { error } = await migrateAll(db, modules);
    if (error) throw new Error('migration failed', { cause: error });
    infra = createInfra();
    target = await infra.startApp({ RATE_LIMIT_MAX: '10000' }, db);
  }, 120_000);

  afterAll(async () => {
    await infra.stop();
    await db.destroy();
    await postgres.stop();
  });

  it('gives the first user a starter server that is not the lobby', async () => {
    const guilds = await guildsOf(admin);
    expect(guilds.map((g) => g.name)).toEqual(['Harmony']);
    const row = await db.selectFrom('guilds').selectAll().executeTakeFirstOrThrow();
    expect(row.is_default).toBe(false);
    expect((await api(target, admin)('/api/admin/lobby')).body).toEqual({ guildId: null });
  });

  it('puts new users in no server by default', async () => {
    const newcomer = unique('newcomer');
    expect(await guildsOf(newcomer)).toEqual([]);
    const channels = (await api(target, newcomer)('/api/channels')).body as { channels: unknown[] };
    expect(channels.channels).toEqual([]);
  });

  it('lets only an instance admin choose the lobby', async () => {
    const [starter] = await guildsOf(admin);
    const stranger = unique('stranger');
    const asStranger = api(target, stranger);
    expect((await asStranger('/api/admin/lobby')).status).toBe(403);
    expect(
      (await asStranger('/api/admin/lobby', { method: 'PUT', body: { guildId: starter?.id } }))
        .status,
    ).toBe(403);
    expect(
      (await api(target, admin)('/api/admin/lobby', { method: 'PUT', body: { guildId: '999999' } }))
        .status,
    ).toBe(404);
  });

  it('adds new users to the lobby once set, and stops when it is cleared', async () => {
    const asAdmin = api(target, admin);
    const [starter] = await guildsOf(admin);
    if (!starter) throw new Error('no starter guild');

    const set = await asAdmin('/api/admin/lobby', { method: 'PUT', body: { guildId: starter.id } });
    expect(set.body).toEqual({ guildId: starter.id });
    expect((await asAdmin('/api/admin/lobby')).body).toEqual({ guildId: starter.id });

    const joiner = unique('joiner');
    expect((await guildsOf(joiner)).map((g) => g.id)).toEqual([starter.id]);
    const channels = (await api(target, joiner)('/api/channels')).body as {
      channels: { name: string }[];
    };
    expect(channels.channels.map((c) => c.name)).toContain('general');

    // Only one lobby at a time: choosing another guild moves it.
    const other = (await asAdmin('/api/guilds', { method: 'POST', body: { name: 'Second' } }))
      .body as GuildSummary;
    await asAdmin('/api/admin/lobby', { method: 'PUT', body: { guildId: other.id } });
    const lobbies = await db
      .selectFrom('guilds')
      .select('id')
      .where('is_default', '=', true)
      .execute();
    expect(lobbies.map((g) => g.id)).toEqual([other.id]);

    await asAdmin('/api/admin/lobby', { method: 'PUT', body: { guildId: null } });
    expect((await asAdmin('/api/admin/lobby')).body).toEqual({ guildId: null });
    expect(await guildsOf(unique('after-clear'))).toEqual([]);
  });

  it('clears the old default guild when migrating an existing install', async () => {
    const { up } = await import('../../migrations/0018_no_default_guild.js');
    const first = await db.selectFrom('guilds').select('id').limit(1).executeTakeFirstOrThrow();
    await db.updateTable('guilds').set({ is_default: true }).where('id', '=', first.id).execute();
    await up(db as Kysely<unknown>);
    const left = await db
      .selectFrom('guilds')
      .select('id')
      .where('is_default', '=', true)
      .execute();
    expect(left).toEqual([]);
  });
});
