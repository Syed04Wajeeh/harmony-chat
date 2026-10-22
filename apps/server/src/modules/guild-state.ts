import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { GuildModule, PermissionDefinition, UpdateGuildModuleBody } from '@harmony/shared';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { HarmonyModule } from './types.js';

/** Carries a guild id; every instance drops its cached state for that guild. */
export const MODULES_INVALIDATE_TOPIC = 'harmony:modules:invalidate';

/** Safety net for a missed invalidation message (a Redis blip): state is re-read this often. */
const TTL_MS = 5 * 60_000;
const MAX_GUILDS = 5000;

export interface ModuleState {
  enabled: boolean;
  settings: Record<string, unknown>;
}

interface Entry {
  loadedAt: number;
  rows: Promise<Map<string, ModuleState>>;
}

const notFound = (id: string) => new AppError(404, 'module_not_found', `No module "${id}"`);

/**
 * Per-guild module state (`guild_modules`), cached in process. Reads cost a map lookup after the
 * first one per guild; writes go to Postgres and tell every instance to forget the guild over
 * Redis, so a toggle takes effect everywhere without any per-request database read.
 */
export class GuildModuleState {
  private readonly cache = new Map<string, Entry>();
  private readonly byId: ReadonlyMap<string, HarmonyModule>;
  /** Filled in as modules register; reported with each module for the role system. */
  readonly permissions = new Map<string, PermissionDefinition[]>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    /** The modules this instance runs. */
    readonly modules: readonly HarmonyModule[],
  ) {
    this.byId = new Map(modules.map((module) => [module.id, module]));
  }

  has(moduleId: string): boolean {
    return this.byId.has(moduleId);
  }

  /** Called when any instance changed a guild's modules. */
  invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }

  async isEnabled(guildId: string | null, moduleId: string): Promise<boolean> {
    const module = this.byId.get(moduleId);
    if (!module) return false;
    if (guildId === null || !module.optional) return true;
    return (await this.state(guildId, module)).enabled;
  }

  /** 404 `module_disabled` unless the module is on for the guild. */
  async require(guildId: string | null, moduleId: string): Promise<void> {
    if (!(await this.isEnabled(guildId, moduleId))) {
      throw new AppError(404, 'module_disabled', 'This feature is turned off in this server');
    }
  }

  async settings<T>(guildId: string | null, moduleId: string): Promise<T> {
    const module = this.byId.get(moduleId);
    if (!module) throw notFound(moduleId);
    if (guildId === null) return defaults(module) as T;
    return (await this.state(guildId, module)).settings as T;
  }

  async list(guildId: string): Promise<GuildModule[]> {
    const rows = await this.rows(guildId);
    return this.modules.map((module) => ({
      ...toApi(module, resolve(module, rows.get(module.id))),
      permissions: this.permissions.get(module.id) ?? [],
    }));
  }

  async update(
    guildId: string,
    moduleId: string,
    patch: UpdateGuildModuleBody,
  ): Promise<ModuleState> {
    const module = this.byId.get(moduleId);
    if (!module) throw notFound(moduleId);
    const rows = await this.rows(guildId);
    const current = resolve(module, rows.get(module.id));

    if (patch.enabled === false && !module.optional) {
      throw new AppError(409, 'module_required', `${module.name} cannot be turned off`);
    }
    let settings = current.settings;
    if (patch.settings !== undefined) {
      if (!module.guildSettings) {
        throw new AppError(400, 'invalid_settings', `${module.name} has no settings`);
      }
      const parsed = module.guildSettings.safeParse({ ...current.settings, ...patch.settings });
      if (!parsed.success) {
        throw new AppError(400, 'invalid_settings', z.prettifyError(parsed.error));
      }
      settings = parsed.data as Record<string, unknown>;
    }
    const enabled = patch.enabled ?? current.enabled;
    if (enabled && !current.enabled) this.requireDependencies(module, rows);
    if (!enabled && current.enabled) this.requireNoDependents(module, rows);

    await this.db
      .insertInto('guild_modules')
      .values({
        guild_id: guildId,
        module_id: moduleId,
        enabled,
        settings: JSON.stringify(settings),
      })
      .onConflict((oc) =>
        oc.columns(['guild_id', 'module_id']).doUpdateSet({
          enabled,
          settings: JSON.stringify(settings),
          updated_at: sql`now()`,
        }),
      )
      .execute();
    this.invalidate(guildId);
    await this.redis.publish(MODULES_INVALIDATE_TOPIC, guildId).catch(() => undefined);
    return { enabled, settings };
  }

  private requireDependencies(module: HarmonyModule, rows: Map<string, ModuleState>): void {
    for (const dependency of module.dependsOn ?? []) {
      const found = this.byId.get(dependency);
      if (found && !resolve(found, rows.get(dependency)).enabled) {
        throw new AppError(
          409,
          'dependency_disabled',
          `${module.name} needs ${found.name}, which is turned off`,
        );
      }
    }
  }

  private requireNoDependents(module: HarmonyModule, rows: Map<string, ModuleState>): void {
    const dependent = this.modules.find(
      (other) => other.dependsOn?.includes(module.id) && resolve(other, rows.get(other.id)).enabled,
    );
    if (dependent) {
      throw new AppError(
        409,
        'module_in_use',
        `${dependent.name} needs ${module.name}; turn it off first`,
      );
    }
  }

  private async state(guildId: string, module: HarmonyModule): Promise<ModuleState> {
    return resolve(module, (await this.rows(guildId)).get(module.id));
  }

  private rows(guildId: string): Promise<Map<string, ModuleState>> {
    const cached = this.cache.get(guildId);
    if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.rows;

    const rows = this.load(guildId);
    if (this.cache.size >= MAX_GUILDS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const entry: Entry = { loadedAt: Date.now(), rows };
    this.cache.set(guildId, entry);
    // A failed load must not be remembered.
    rows.catch(() => {
      if (this.cache.get(guildId) === entry) this.cache.delete(guildId);
    });
    return rows;
  }

  private async load(guildId: string): Promise<Map<string, ModuleState>> {
    const stored = await this.db
      .selectFrom('guild_modules')
      .select(['module_id', 'enabled', 'settings'])
      .where('guild_id', '=', guildId)
      .execute();
    return new Map(
      stored.map((row) => [row.module_id, { enabled: row.enabled, settings: row.settings }]),
    );
  }
}

function defaults(module: HarmonyModule): Record<string, unknown> {
  return module.guildSettings ? (module.guildSettings.parse({}) as Record<string, unknown>) : {};
}

/** Stored state with defaults filled in. Settings that no longer fit the schema fall back to defaults. */
function resolve(module: HarmonyModule, stored: ModuleState | undefined): ModuleState {
  const enabled = module.optional ? (stored?.enabled ?? true) : true;
  if (!module.guildSettings) return { enabled, settings: {} };
  const parsed = module.guildSettings.safeParse(stored?.settings ?? {});
  return {
    enabled,
    settings: parsed.success ? (parsed.data as Record<string, unknown>) : defaults(module),
  };
}

function toApi(module: HarmonyModule, state: ModuleState): GuildModule {
  return {
    id: module.id,
    name: module.name,
    description: module.description,
    optional: module.optional,
    enabled: state.enabled,
    dependsOn: [...(module.dependsOn ?? [])],
    settings: state.settings,
    settingsSchema: module.guildSettings
      ? z.toJSONSchema(module.guildSettings, { io: 'input' })
      : null,
    permissions: [],
  };
}
