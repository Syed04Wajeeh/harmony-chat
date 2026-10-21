import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import { inject } from 'vitest';
import WebSocket from 'ws';
import { ServerFrame } from '@harmony/shared';
import { buildApp } from '../../../src/app.js';
import { loadConfig, type Config } from '../../../src/config.js';
import { createDb } from '../../../src/db.js';
import type { Database } from '../../../src/db/schema.js';
import { createRedis } from '../../../src/redis.js';

export const PROXY_SECRET = 'test-proxy-secret-test-proxy-secret-0123456789';
export const PUBLIC_ORIGIN = 'https://chat.example.ts.net:18470';

export interface TestApp {
  app: FastifyInstance;
  config: Config;
  port: number;
  url: string;
  wsUrl: string;
}

export interface Infra {
  db: Kysely<Database>;
  redis: Redis;
  startApp(overrides?: Record<string, string>): Promise<TestApp>;
  stop(): Promise<void>;
}

export function createInfra(): Infra {
  const db = createDb(inject('databaseUrl'));
  const redis = createRedis(inject('redisUrl'));
  const apps: FastifyInstance[] = [];

  return {
    db,
    redis,
    async startApp(overrides = {}) {
      const config = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: inject('databaseUrl'),
        REDIS_URL: inject('redisUrl'),
        WEB_DIST_DIR: '/nonexistent',
        PROXY_SHARED_SECRET: PROXY_SECRET,
        PUBLIC_ORIGIN,
        INSTANCE_ID: `test-${randomUUID().slice(0, 8)}`,
        ...overrides,
      });
      const app = await buildApp({ config, db, redis });
      apps.push(app);
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      return {
        app,
        config,
        port,
        url: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}`,
      };
    },
    async stop() {
      await Promise.all(apps.map((app) => app.close()));
      await db.destroy();
      redis.disconnect();
    },
  };
}

export function proxyHeaders(login: string, extra: Record<string, string> = {}) {
  return {
    'x-harmony-proxy-secret': PROXY_SECRET,
    'tailscale-user-login': login,
    'tailscale-user-name': login.split('@')[0] ?? login,
    origin: PUBLIC_ORIGIN,
    ...extra,
  };
}

export function api(target: TestApp, login: string) {
  return async (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const res = await fetch(`${target.url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...proxyHeaders(login),
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: await res.json() };
  };
}

/** A WebSocket client that records every parsed server frame. */
export class TestSocket {
  readonly frames: ServerFrame[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.frames.push(
        ServerFrame.parse(
          JSON.parse(new TextDecoder().decode(Array.isArray(data) ? Buffer.concat(data) : data)),
        ),
      );
    });
  }

  static async connect(
    target: TestApp,
    login: string,
    headers: Record<string, string> = {},
  ): Promise<TestSocket> {
    const socket = new WebSocket(`${target.wsUrl}/api/ws`, {
      headers: { ...proxyHeaders(login), ...headers },
    });
    const client = new TestSocket(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('unexpected-response', (req, res) => {
        req.destroy();
        reject(new Error(`HTTP ${res.statusCode}`));
      });
      socket.once('error', reject);
    });
    return client;
  }

  send(frame: unknown): void {
    this.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  of<T extends ServerFrame['type']>(type: T): Extract<ServerFrame, { type: T }>[] {
    return this.frames.filter((f): f is Extract<ServerFrame, { type: T }> => f.type === type);
  }

  async waitFor<T extends ServerFrame['type']>(
    type: T,
    count = 1,
    timeoutMs = 5000,
  ): Promise<Extract<ServerFrame, { type: T }>[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.of(type).length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} ${type} frame(s)`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.of(type);
  }

  async subscribe(channelId: string, lastSeenId?: string): Promise<void> {
    const before = this.of('backfill').length;
    this.send({ type: 'subscribe', channelId, ...(lastSeenId && { lastSeenId }) });
    await this.waitFor('backfill', before + 1);
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.socket.once('close', () => resolve()));
    this.socket.close();
    await closed;
  }
}

export async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createChannel(db: Kysely<Database>): Promise<string> {
  const { id } = await db
    .insertInto('channels')
    .values({ name: `t-${randomUUID().slice(0, 12)}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}
