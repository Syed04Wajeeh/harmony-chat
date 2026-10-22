import { ModuleId, RESERVED_MODULE_IDS } from '@harmony/shared';
import type { HarmonyModule } from './types.js';

export class ModuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleError';
  }
}

/**
 * Validates a module list and orders it so every module comes after the ones it depends on.
 * Ties keep the order of the list, so the result is stable. Throws a `ModuleError` that names
 * the problem: a bad or duplicate id, a missing dependency, or a cycle.
 */
export function sortModules(modules: readonly HarmonyModule[]): HarmonyModule[] {
  const byId = new Map<string, HarmonyModule>();
  for (const module of modules) {
    if (!ModuleId.safeParse(module.id).success) {
      throw new ModuleError(`Module id "${module.id}" must be kebab-case`);
    }
    if (RESERVED_MODULE_IDS.includes(module.id)) {
      throw new ModuleError(`Module id "${module.id}" is reserved by the core protocol`);
    }
    if (byId.has(module.id)) throw new ModuleError(`Module "${module.id}" is listed twice`);
    byId.set(module.id, module);
  }

  const sorted: HarmonyModule[] = [];
  const done = new Set<string>();
  const path: string[] = [];

  const visit = (module: HarmonyModule): void => {
    if (done.has(module.id)) return;
    if (path.includes(module.id)) {
      throw new ModuleError(`Dependency cycle: ${[...path, module.id].join(' -> ')}`);
    }
    path.push(module.id);
    for (const dependency of module.dependsOn ?? []) {
      const found = byId.get(dependency);
      if (!found) {
        throw new ModuleError(`Module "${module.id}" depends on unknown module "${dependency}"`);
      }
      visit(found);
    }
    path.pop();
    done.add(module.id);
    sorted.push(module);
  };
  modules.forEach(visit);

  for (const module of sorted) {
    if (module.guildSettings && !module.guildSettings.safeParse({}).success) {
      throw new ModuleError(`Module "${module.id}": every guild setting needs a default`);
    }
  }
  return sorted;
}

/**
 * The modules this instance runs: the sorted list minus `MODULES_DISABLED`. Unknown ids in the
 * disabled list are an error (a typo would otherwise leave the module running), and so is
 * disabling a module another running module needs.
 */
export function activeModules(
  modules: readonly HarmonyModule[],
  disabled: readonly string[] = [],
): HarmonyModule[] {
  const sorted = sortModules(modules);
  const known = new Set(sorted.map((module) => module.id));
  for (const id of disabled) {
    if (!known.has(id)) throw new ModuleError(`MODULES_DISABLED names unknown module "${id}"`);
  }
  const active = sorted.filter((module) => !disabled.includes(module.id));
  for (const module of active) {
    for (const dependency of module.dependsOn ?? []) {
      if (disabled.includes(dependency)) {
        throw new ModuleError(
          `Module "${module.id}" needs "${dependency}", which MODULES_DISABLED turns off`,
        );
      }
    }
  }
  return active;
}
