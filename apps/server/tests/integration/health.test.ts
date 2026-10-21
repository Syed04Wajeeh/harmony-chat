import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/schema.js';
import { createRedis } from '../../src/redis.js';
import { createInfra, type Infra, type TestApp } from './support/harness.js';

describe('health endpoints', () => {
  let infra: Infra;
  let db: Kysely<Database>;
  let target: TestApp;

  beforeAll(async () => {
    infra = createInfra();
    db = infra.db;
    target = await infra.startApp();
  });

  afterAll(() => infra.stop());

  it('applies the channels and messages migration and seeds #general', async () => {
    const tables = await db.introspection.getTables();
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['users', 'channels', 'messages']),
    );
    const general = await db
      .selectFrom('channels')
      .select('name')
      .where('name', '=', 'general')
      .execute();
    expect(general).toHaveLength(1);
  });

  it('GET /healthz is 200 and needs no authentication', async () => {
    const res = await target.app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz is 200 when dependencies are up', async () => {
    const res = await target.app.inject('/readyz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'up', redis: 'up' } });
  });

  it('GET /readyz is 503 when Redis is unreachable', async () => {
    const { buildApp } = await import('../../src/app.js');
    const unreachable = createRedis('redis://127.0.0.1:1');
    unreachable.on('error', () => undefined);
    const app = await buildApp({ config: target.config, db, redis: unreachable });
    const res = await app.inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', checks: { postgres: 'up', redis: 'down' } });
    await app.close();
    unreachable.disconnect();
  });
});
