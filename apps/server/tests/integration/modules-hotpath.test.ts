import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Database } from '../../src/db/schema.js';
import { modules as shipped } from '../../src/modules/index.js';
import { api, createChannel, createInfra, type Infra } from './support/harness.js';

/** A connection that records every statement it runs. */
function countingDb(statements: string[]): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: inject('databaseUrl'), max: 5 }),
    }),
    log: (event) => {
      if (event.level === 'query') statements.push(event.query.sql);
    },
  });
}

describe('the message send path with modules loaded', () => {
  let infra: Infra;
  beforeAll(() => {
    infra = createInfra();
  });
  afterAll(async () => {
    await infra.stop();
  });

  async function statementsPerSend(modules: Parameters<Infra['startApp']>[2]) {
    const statements: string[] = [];
    const db = countingDb(statements);
    const app = await infra.startApp({ MESSAGE_RATE_MAX: '1000' }, db, modules);
    const login = `hot-${randomUUID().slice(0, 8)}@example.com`;
    const channelId = await createChannel(infra.db, [login]);
    const send = () =>
      api(app, login)(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        body: { content: 'x' },
      });
    await send(); // warm the user cache
    statements.length = 0;
    const res = await send();
    expect(res.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const used = [...statements];
    await db.destroy();
    return used;
  }

  it('issues exactly the statements it did before modules existed, and none of the modules’', async () => {
    const bare = await statementsPerSend([]);
    const full = await statementsPerSend(shipped);
    expect(full).toEqual(bare);
    expect(full.join('\n')).not.toMatch(/guild_modules|poll/);
    expect(full.length).toBeLessThanOrEqual(6);
  });
});
