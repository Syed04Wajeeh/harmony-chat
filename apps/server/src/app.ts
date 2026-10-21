import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import type { HealthResponse } from '@harmony/shared';
import type { Config } from './config.js';
import type { Database } from './db/schema.js';

export interface AppDeps {
  config: Pick<Config, 'NODE_ENV' | 'LOG_LEVEL' | 'WEB_DIST_DIR'>;
  db: Kysely<Database>;
  redis: Redis;
}

const API_PREFIXES = ['/api/', '/healthz', '/readyz'];

export async function buildApp({ config, db, redis }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    genReqId: () => crypto.randomUUID(),
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
    },
  });

  app.get('/healthz', (): HealthResponse => ({ status: 'ok' }));

  app.get('/readyz', async (request, reply): Promise<HealthResponse> => {
    const [postgres, cache] = await Promise.all([
      check(() => sql`select 1`.execute(db)),
      check(() => redis.ping()),
    ]);
    const checks = { postgres, redis: cache };
    const ready = postgres === 'up' && cache === 'up';
    if (!ready) {
      request.log.warn({ checks }, 'readiness check failed');
      void reply.code(503);
    }
    return { status: ready ? 'ok' : 'degraded', checks };
  });

  const webRoot = path.resolve(config.WEB_DIST_DIR);
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      const isApi = API_PREFIXES.some((prefix) => request.url.startsWith(prefix));
      if (request.method !== 'GET' || isApi) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

async function check(probe: () => Promise<unknown>): Promise<'up' | 'down'> {
  try {
    await probe();
    return 'up';
  } catch {
    return 'down';
  }
}
