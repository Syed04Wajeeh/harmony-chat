import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDb } from '../../src/db.js';
import type { Database } from '../../src/db/schema.js';
import { createMigrator } from '../../src/migrator.js';
import { createRedis } from '../../src/redis.js';

describe('health endpoints', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let db: Kysely<Database>;
  let redis: Redis;
  let app: FastifyInstance;

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    db = createDb(postgres.getConnectionUri());
    redis = createRedis(redisContainer.getConnectionUrl());

    const { error } = await createMigrator(db).migrateToLatest();
    if (error) throw new Error('migration failed', { cause: error });

    app = await buildApp({
      config: { NODE_ENV: 'test', LOG_LEVEL: 'silent', WEB_DIST_DIR: '/nonexistent' },
      db,
      redis,
    });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    redis.disconnect();
    await Promise.all([postgres.stop(), redisContainer.stop().catch(() => undefined)]);
  });

  it('applies the users migration', async () => {
    const tables = await db.introspection.getTables();
    expect(tables.map((t) => t.name)).toContain('users');
  });

  it('GET /healthz is 200', async () => {
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz is 200 when dependencies are up', async () => {
    const res = await app.inject('/readyz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'up', redis: 'up' } });
  });

  it('GET /readyz is 503 when Redis is down', async () => {
    await redisContainer.stop();
    const res = await app.inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', checks: { postgres: 'up', redis: 'down' } });
  });
});
