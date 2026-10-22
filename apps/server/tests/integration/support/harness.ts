import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import { inject } from 'vitest';
import WebSocket from 'ws';
import { ModuleFrame, ServerFrame } from '@harmony/shared';
import { buildApp } from '../../../src/app.js';
import { loadConfig, type Config } from '../../../src/config.js';
import { createDb } from '../../../src/db.js';
import type { Database } from '../../../src/db/schema.js';
import { createGuildWithGeneral } from '../../../src/guilds/membership.js';
import { modules as defaultModules } from '../../../src/modules/index.js';
import type { HarmonyModule } from '../../../src/modules/types.js';
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
  startApp(
    overrides?: Record<string, string>,
    appDb?: Kysely<Database>,
    modules?: readonly HarmonyModule[],
  ): Promise<TestApp>;
  stop(): Promise<void>;
}

export function createInfra(): Infra {
  const db = createDb(inject('databaseUrl'));
  const redis = createRedis(inject('redisUrl'));
  const apps: FastifyInstance[] = [];

  return {
    db,
    redis,
    async startApp(overrides = {}, appDb = db, modules = defaultModules) {
      const env = {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: inject('databaseUrl'),
        REDIS_URL: inject('redisUrl'),
        WEB_DIST_DIR: '/nonexistent',
        PROXY_SHARED_SECRET: PROXY_SECRET,
        PUBLIC_ORIGIN,
        INSTANCE_ID: `test-${randomUUID().slice(0, 8)}`,
        UPLOAD_DIR: mkdtempSync(path.join(tmpdir(), 'harmony-uploads-')),
        ...overrides,
      };
      const config = loadConfig(env);
      const app = await buildApp({ config, db: appDb, redis, env, modules });
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
    const text = await res.text();
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers) as Record<string, string>,
      body: (text ? JSON.parse(text) : null) as unknown,
    };
  };
}

/** A WebSocket client that records every parsed server frame. */
export class TestSocket {
  readonly frames: ServerFrame[] = [];
  /** Frames that belong to modules (`<moduleId>.<name>`). */
  readonly moduleFrames: ModuleFrame[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const json: unknown = JSON.parse(
        new TextDecoder().decode(Array.isArray(data) ? Buffer.concat(data) : data),
      );
      const core = ServerFrame.safeParse(json);
      if (core.success) this.frames.push(core.data);
      else this.moduleFrames.push(ModuleFrame.parse(json));
    });
  }

  static async connect(
    target: TestApp,
    login: string,
    headers: Record<string, string> = {},
  ): Promise<TestSocket> {
    return TestSocket.connectWith(target, { ...proxyHeaders(login), ...headers });
  }

  /** Connects with exactly these headers, for credentials other than the proxy identity. */
  static async connectWith(target: TestApp, headers: Record<string, string>): Promise<TestSocket> {
    const socket = new WebSocket(`${target.wsUrl}/api/ws`, { headers });
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

  ofModule(type: string): ModuleFrame[] {
    return this.moduleFrames.filter((frame) => frame.type === type);
  }

  async waitForModule(type: string, count = 1, timeoutMs = 5000): Promise<ModuleFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.ofModule(type).length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} ${type} frame(s)`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.ofModule(type);
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

/** Creates the user row the way the first request would, so tests can reference its id. */
export async function ensureUser(
  db: Kysely<Database>,
  login: string,
  { admin = false }: { admin?: boolean } = {},
): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({
      login,
      display_name: login.split('@')[0] ?? login,
      avatar_url: null,
      is_admin: admin,
    })
    .onConflict((oc) =>
      oc
        .column('login')
        .doUpdateSet((eb) => ({ is_admin: admin ? true : eb.ref('users.is_admin') })),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface ChannelOptions {
  private?: boolean;
  createdBy?: string;
  name?: string;
  /** Defaults to a new guild owned by `createdBy` (or the first member) containing `members`. */
  guildId?: string;
}

/** A guild owned by `ownerLogin` whose members are `members` too. Has no channels yet. */
export async function createGuild(
  db: Kysely<Database>,
  ownerLogin: string,
  members: string[] = [],
  name = 'Test guild',
): Promise<string> {
  const ownerId = await ensureUser(db, ownerLogin);
  const guild = await db
    .insertInto('guilds')
    .values({ name, owner_id: ownerId, icon_attachment_id: null })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const login of [ownerLogin, ...members]) await addGuildMember(db, guild.id, login);
  return guild.id;
}

/** Mirrors what the first real user's arrival does: a default guild with a `general` channel. */
export async function ensureDefaultGuild(db: Kysely<Database>): Promise<void> {
  const existing = await db
    .selectFrom('guilds')
    .select('id')
    .where('is_default', '=', true)
    .executeTakeFirst();
  if (existing) return;
  const owner = await ensureUser(db, 'default-owner@example.com');
  await db.transaction().execute((trx) => createGuildWithGeneral(trx, 'Harmony', owner, true));
}

export async function addGuildMember(db: Kysely<Database>, guildId: string, login: string) {
  const userId = await ensureUser(db, login);
  await db
    .insertInto('guild_members')
    .values({ guild_id: guildId, user_id: userId })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return userId;
}

/**
 * A text channel. Public channels include every guild member; private ones only `members`.
 * Without `guildId`, a fresh guild is created holding the creator and `members`.
 */
export async function createChannel(
  db: Kysely<Database>,
  members: string[] = [],
  options: ChannelOptions = {},
): Promise<string> {
  const owner = options.createdBy ?? members[0] ?? `owner-${randomUUID().slice(0, 8)}@example.com`;
  const guildId = options.guildId ?? (await createGuild(db, owner, members));
  const creator = await ensureUser(db, owner);
  const isPrivate = options.private ?? false;
  const { id } = await db
    .insertInto('channels')
    .values({
      guild_id: guildId,
      name: options.name ?? `t-${randomUUID().slice(0, 12)}`,
      is_private: isPrivate,
      created_by: creator,
      topic: null,
      dm_key: null,
      archived_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (isPrivate) {
    for (const login of members) await addMember(db, id, login);
  } else {
    await db
      .insertInto('channel_members')
      .columns(['channel_id', 'user_id', 'last_read_message_id'])
      .expression((eb) =>
        eb
          .selectFrom('guild_members')
          .select([eb.val(id).as('channel_id'), 'user_id', eb.val(null).as('last_read_message_id')])
          .where('guild_id', '=', guildId),
      )
      .execute();
  }
  return id;
}

export async function addMember(db: Kysely<Database>, channelId: string, login: string) {
  const userId = await ensureUser(db, login);
  await db
    .insertInto('channel_members')
    .values({ channel_id: channelId, user_id: userId, last_read_message_id: null })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return userId;
}

export async function insertMessages(
  db: Kysely<Database>,
  channelId: string,
  authorLogin: string,
  count: number,
): Promise<string[]> {
  const authorId = await ensureUser(db, authorLogin);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = await db
      .insertInto('messages')
      .values({
        channel_id: channelId,
        author_id: authorId,
        content: `seed ${i}`,
        reply_to_id: null,
        edited_at: null,
        deleted_at: null,
        pinned_at: null,
        pinned_by: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids.push(row.id);
  }
  return ids;
}
