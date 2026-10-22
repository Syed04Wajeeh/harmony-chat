import { existsSync } from 'node:fs';
import path from 'node:path';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { sql, type Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import { MAX_FRAME_BYTES, type HealthResponse } from '@harmony/shared';
import { authPlugin } from './auth/plugin.js';
import { BotAuthenticator } from './bots/auth.js';
import { botRoutes } from './bots/routes.js';
import { BotService } from './bots/service.js';
import { CommandRegistry } from './commands/registry.js';
import { InteractionService } from './commands/interactions.js';
import { commandRoutes } from './commands/routes.js';
import { OutboundValidator } from './outbound/validator.js';
import { parseAllowlist } from './outbound/policy.js';
import { WebhookService } from './webhooks/service.js';
import { webhookRoutes } from './webhooks/routes.js';
import type { AuthPolicy } from './auth/policy.js';
import { UserStore } from './auth/user-store.js';
import { channelRoutes } from './channels/routes.js';
import { ChannelService } from './channels/service.js';
import { guildRoutes } from './guilds/routes.js';
import { GuildService } from './guilds/service.js';
import type { Config } from './config.js';
import type { Database } from './db/schema.js';
import { AppError } from './errors.js';
import { messageRoutes } from './messages/routes.js';
import { MessageService } from './messages/service.js';
import { PresenceService } from './presence/service.js';
import { RateLimiter } from './rate-limit.js';
import { EventBus } from './realtime/events.js';
import { Hub } from './realtime/hub.js';
import { realtimeRoutes } from './realtime/routes.js';
import { TypingService } from './realtime/typing.js';
import { LocalDiskStorage, type Storage } from './uploads/storage.js';
import { userRoutes } from './users/routes.js';
import { MessageDecorators } from './messages/decorators.js';
import { DomainEvents } from './modules/domain-events.js';
import { moduleGate } from './modules/gate.js';
import { GuildModuleState, MODULES_INVALIDATE_TOPIC } from './modules/guild-state.js';
import { ModuleHost } from './modules/host.js';
import { modules as defaultModules } from './modules/index.js';
import { activeModules } from './modules/registry.js';
import { moduleRoutes } from './modules/routes.js';
import type { HarmonyModule } from './modules/types.js';

export interface AppDeps {
  config: Config;
  db: Kysely<Database>;
  redis: Redis;
  storage?: Storage;
  /** Where modules read their settings from; defaults to the process environment. */
  env?: NodeJS.ProcessEnv;
  /** The module list; defaults to `modules/index.ts`. Tests pass their own. */
  modules?: readonly HarmonyModule[];
}

const API_PREFIXES = ['/api/', '/healthz', '/readyz'];

export async function buildApp({
  config,
  db,
  redis,
  storage,
  env = process.env,
  modules = defaultModules,
}: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    genReqId: () => crypto.randomUUID(),
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof AppError) {
      if (error.headers) void reply.headers(error.headers);
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({ code: 'invalid_request', message: 'Invalid request' });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(500).send({ code: 'internal', message: 'Internal error' });
    }
    return reply.code(status).send({ code: error.code ?? 'bad_request', message: error.message });
  });
  app.setNotFoundHandler((request, reply) => {
    const isApi = API_PREFIXES.some((prefix) => request.url.startsWith(prefix));
    if (!webRoot || request.method !== 'GET' || isApi) {
      return reply.code(404).send({ code: 'not_found', message: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  const webRoot = existsSync(config.WEB_DIST_DIR) ? path.resolve(config.WEB_DIST_DIR) : null;

  app.get('/healthz', (): HealthResponse => ({ service: 'harmony', status: 'ok' }));

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

  if (webRoot) await app.register(fastifyStatic, { root: webRoot });

  const subscriber = redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
  const hub = new Hub(subscriber, app.log, config.WS_HEARTBEAT_INTERVAL_MS);
  app.addHook('onClose', () => {
    subscriber.disconnect();
  });

  const events = new EventBus(redis);
  const domain = new DomainEvents(app.log);
  const decorators = new MessageDecorators();
  const limiter = (name: string, max: number, windowSeconds: number) =>
    new RateLimiter(redis, name, max, windowSeconds);
  const channels = new ChannelService(db, events, domain);
  const messages = new MessageService(
    db,
    events,
    channels,
    limiter('messages', config.MESSAGE_RATE_MAX, config.MESSAGE_RATE_WINDOW_SECONDS),
    domain,
    decorators,
  );
  const users = new UserStore(db, undefined, domain);
  const presence = new PresenceService(
    redis,
    db,
    events,
    { ttlMs: config.PRESENCE_TTL_MS, sweepMs: config.PRESENCE_SWEEP_MS },
    app.log,
  );
  const files = storage ?? new LocalDiskStorage(config.UPLOAD_DIR);
  const guilds = new GuildService(db, events, channels, presence, files, domain);
  const typing = new TypingService(redis, events, channels);
  const allowlist = parseAllowlist(config.OUTBOUND_PRIVATE_ALLOWLIST);
  const bots = new BotService(
    db,
    events,
    guilds,
    new OutboundValidator(allowlist),
    config.MAX_BOTS_PER_USER,
    domain,
  );

  const active = activeModules(modules, config.MODULES_DISABLED);
  const moduleState = new GuildModuleState(db, redis, active);
  hub
    .listen(MODULES_INVALIDATE_TOPIC, (guildId) => moduleState.invalidate(guildId))
    .catch((err: unknown) => app.log.warn({ err }, 'module state invalidation subscribe failed'));
  const host = new ModuleHost({
    modules: active,
    env,
    instanceId: config.INSTANCE_ID,
    log: app.log,
    db,
    redis,
    storage: files,
    events,
    domain,
    decorators,
    state: moduleState,
    messages,
    channels,
  });

  const commandRegistry = new CommandRegistry(db, host.commands, moduleState);
  const interactions = new InteractionService(
    db,
    events,
    channels,
    messages,
    limiter('commands', config.COMMAND_RATE_MAX, config.COMMAND_RATE_WINDOW_SECONDS),
    { deadlineMs: config.INTERACTION_DEADLINE_MS, allowlist },
    app.log,
    host.commands,
    moduleState,
  );
  const webhooks = new WebhookService(
    db,
    channels,
    guilds,
    messages,
    limiter('webhooks', config.WEBHOOK_RATE_MAX, config.WEBHOOK_RATE_WINDOW_SECONDS),
  );
  app.addHook('onReady', async () => {
    presence.start();
    await host.start();
  });
  app.addHook('onClose', async () => {
    presence.stop();
    await host.stop();
    await interactions.drain();
  });

  await app.register(
    async (api) => {
      // Before auth, so its onRequest/onResponse hooks also run for rejected upgrades and
      // destroy their sockets. preClose is added first so it runs first and closes with 1001.
      api.addHook('preClose', () => {
        hub.closeAll(1001, 'server shutting down');
      });
      await api.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
      await api.register(authPlugin, {
        policy: authPolicy(config),
        users,
        bots: new BotAuthenticator(db),
      });
      await api.register(rateLimit, {
        redis,
        nameSpace: 'harmony:ratelimit:http:',
        // Bots draw from their own, separately configured bucket.
        max: (request) => (request.bot ? config.BOT_RATE_LIMIT_MAX : config.RATE_LIMIT_MAX),
        timeWindow: config.RATE_LIMIT_WINDOW_MS,
        keyGenerator: (request) => (request.bot ? `bot:${request.bot.id}` : request.user.login),
        skipOnError: true,
        errorResponseBuilder: () => new AppError(429, 'rate_limited', 'Too many requests'),
      });
      await api.register(userRoutes, { users, presence });
      await api.register(guildRoutes, { guilds, channels });
      await api.register(channelRoutes, { channels });
      await api.register(messageRoutes, { channels, messages });
      await api.register(botRoutes, { bots });
      await api.register(commandRoutes, { registry: commandRegistry, interactions });
      await api.register(webhookRoutes, { webhooks });
      await api.register(moduleRoutes, { state: moduleState, guilds, events });
      await api.register(realtimeRoutes, {
        hub,
        channels,
        messages,
        users,
        presence,
        typing,
        interactions,
        frames: host.frames,
        instanceId: config.INSTANCE_ID,
        presenceHeartbeatMs: config.PRESENCE_HEARTBEAT_MS,
        frameBurst: config.WS_FRAME_BURST,
        frameRefillPerSecond: config.WS_FRAME_REFILL_PER_SECOND,
      });
      // Modules come last: they can rely on authentication, rate limits and error handling above.
      api.addHook('preHandler', moduleGate(moduleState, db));
      await host.load(api);
    },
    { prefix: '/api' },
  );

  return app;
}

export function authPolicy(config: Config): AuthPolicy {
  const devLogin = config.NODE_ENV === 'development' ? config.DEV_AUTH_LOGIN : undefined;
  return {
    proxySecret: config.PROXY_SHARED_SECRET,
    publicOrigin: config.PUBLIC_ORIGIN,
    allowedLogins: config.ALLOWED_LOGINS,
    devIdentity: devLogin
      ? {
          login: devLogin,
          displayName: config.DEV_AUTH_NAME ?? devLogin.split('@')[0] ?? devLogin,
          avatarUrl: null,
        }
      : undefined,
  };
}

async function check(probe: () => Promise<unknown>): Promise<'up' | 'down'> {
  try {
    await probe();
    return 'up';
  } catch {
    return 'down';
  }
}
