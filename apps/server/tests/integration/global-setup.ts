import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';
import { createDb } from '../../src/db.js';
import { migrateAll } from '../../src/migrator.js';
import { modules } from '../../src/modules/index.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

/** One Postgres and one Redis shared by every integration test file. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const db = createDb(postgres.getConnectionUri());
  const { error } = await migrateAll(db, modules);
  await db.destroy();
  if (error) throw new Error('migration failed', { cause: error });

  project.provide('databaseUrl', postgres.getConnectionUri());
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
