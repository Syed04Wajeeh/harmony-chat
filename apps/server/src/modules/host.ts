import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { ChannelEvent, MODULE_FRAME_TYPE, ModuleFrame } from '@harmony/shared';
import { parseEnv } from '../config.js';
import type { Database } from '../db/schema.js';
import { enqueueEvent } from '../events/outbox.js';
import type { ChannelService } from '../channels/service.js';
import type { MessageDecorators } from '../messages/decorators.js';
import type { MessageService } from '../messages/service.js';
import { RateLimiter } from '../rate-limit.js';
import type { EventBus } from '../realtime/events.js';
import type { Storage } from '../uploads/storage.js';
import { BuiltinCommands } from './builtin-commands.js';
import type { DomainEvents } from './domain-events.js';
import type { GuildModuleState } from './guild-state.js';
import { ModuleError } from './registry.js';
import type { HarmonyModule, ModuleContext, ModuleFrameOut } from './types.js';
import { ModuleFrames } from './ws-frames.js';

export interface ModuleHostDeps {
  /** The modules this instance runs, in dependency order. */
  modules: readonly HarmonyModule[];
  env: NodeJS.ProcessEnv;
  instanceId: string;
  log: FastifyBaseLogger;
  db: Kysely<Database>;
  redis: Redis;
  storage: Storage;
  events: EventBus;
  domain: DomainEvents;
  decorators: MessageDecorators;
  state: GuildModuleState;
  messages: MessageService;
  channels: ChannelService;
}

type Hook = () => void | Promise<void>;

/**
 * Builds a `ModuleContext` for each module, calls its `register`, and keeps what the modules
 * registered (commands, frame handlers, lifecycle hooks) for the rest of the app to use.
 */
export class ModuleHost {
  readonly commands = new BuiltinCommands();
  readonly frames = new ModuleFrames();
  private readonly ready: Hook[] = [];
  private readonly closing: Hook[] = [];

  constructor(private readonly deps: ModuleHostDeps) {}

  /** Registers every module. `api` is the `/api` scope: routes go below it, after authentication. */
  async load(api: FastifyInstance): Promise<void> {
    for (const module of this.deps.modules) {
      const config = module.config ? parseEnv(module.config, this.deps.env) : {};
      await module.register(this.contextFor(module, config, api));
    }
  }

  /** Runs after the server is listening; a failing hook is logged and does not stop the rest. */
  async start(): Promise<void> {
    await this.runAll(this.ready, 'ready');
  }

  /** Runs when the app closes, last registered first. */
  async stop(): Promise<void> {
    await this.runAll([...this.closing].reverse(), 'close');
  }

  private async runAll(hooks: Hook[], phase: string): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (err) {
        this.deps.log.warn({ err }, `module ${phase} hook failed`);
      }
    }
  }

  private contextFor(module: HarmonyModule, config: unknown, api: FastifyInstance): ModuleContext {
    const { deps } = this;
    const { id } = module;
    const log = deps.log.child({ module: id });
    const permissions: { key: string; description: string }[] = [];
    deps.state.permissions.set(id, permissions);
    const coreFrames = new Set(module.coreFrames ?? []);

    /** A module's own frames are namespaced; core frames only if the module declared them. */
    const checked = (frame: ModuleFrameOut): ModuleFrame => {
      if (coreFrames.has(frame.type)) return ChannelEvent.parse(frame);
      if (!frame.type.startsWith(`${id}.`) || !MODULE_FRAME_TYPE.test(frame.type)) {
        throw new ModuleError(`Module "${id}" may not publish a "${frame.type}" frame`);
      }
      return ModuleFrame.parse(frame);
    };

    return {
      id,
      log,
      db: deps.db,
      config,
      storage: deps.storage,
      redis: deps.redis,
      instanceId: deps.instanceId,

      routes: (plugin) => {
        void api.register(async (scope) => {
          scope.addHook('onRoute', (route) => {
            const declared = route.config?.module;
            if (declared !== undefined && (declared !== id || !route.config?.moduleScope)) {
              throw new ModuleError(
                `${route.method.toString()} ${route.url}: config.module must be "${id}", with a moduleScope`,
              );
            }
          });
          await scope.register(async (inner) => {
            await plugin(inner);
          });
        });
      },
      requireEnabled: (guildId) => deps.state.require(guildId, id),
      settings: { get: (guildId) => deps.state.settings(guildId, id) },

      ws: {
        on: (type, schema, handler, options) => {
          this.frames.register(id, type, {
            schema,
            scope: options?.scope,
            run: (frame, caller) => handler(frame as never, caller),
          });
        },
      },

      events: {
        on: (name, handler) => {
          deps.domain.on(name, async (event) => {
            const guildId = (event as { guildId?: string | null }).guildId ?? null;
            if (module.optional && !(await deps.state.isEnabled(guildId, id))) return;
            try {
              await handler(event);
            } catch (err) {
              log.warn({ err, event: name }, 'event handler failed');
            }
          });
        },
        emit: (name, event) => deps.domain.emit(name, event),
      },

      messages: {
        decorate: (decorator) =>
          deps.decorators.register(id, async (ids, db) => {
            try {
              return await decorator(ids, db);
            } catch (err) {
              log.error({ err }, 'message decorator failed');
              return new Map();
            }
          }),
        send: (input) => deps.messages.send(input),
        sendMarked: (input, setup) => deps.messages.send({ ...input, module: { id, setup } }),
        update: (target, change) => deps.messages.update(target, change),
        find: (messageId, userId) => deps.messages.find(messageId, userId),
        load: (messageId) => deps.messages.reader.loadOne(messageId),
        reader: deps.messages.reader,
      },

      channels: {
        requireMember: (channelId, userId) => deps.channels.requireMember(channelId, userId),
      },

      commands: {
        register: (command) => this.commands.register(id, module.name, command),
      },

      publish: {
        channel: async (channelId, frame) => {
          await deps.events.moduleToChannel(channelId, checked(frame));
        },
        user: async (userId, frame) => {
          await deps.events.moduleToUser(userId, checked(frame));
        },
      },

      outbox: { enqueue: (trx, event) => enqueueEvent(trx, event) },
      limiter: (name, max, windowSeconds) =>
        new RateLimiter(deps.redis, `${id}.${name}`, max, windowSeconds),

      permissions: {
        define: (key, description) => {
          const full = `${id}.${key}`;
          if (permissions.some((p) => p.key === full)) {
            throw new ModuleError(`Permission "${full}" is defined twice`);
          }
          permissions.push({ key: full, description });
        },
      },

      onReady: (fn) => void this.ready.push(fn),
      onClose: (fn) => void this.closing.push(fn),
    };
  }
}
