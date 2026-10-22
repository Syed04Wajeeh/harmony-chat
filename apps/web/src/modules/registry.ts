import type { GuildModule, ModuleFrame } from '@harmony/shared';
import { appStore } from '../store/store.js';
import { webModules } from './index.js';
import type { ModuleStoreApi, WebModule } from './types.js';

const store: ModuleStoreApi = {
  patchMessage: (channelId, messageId, update) =>
    appStore.getState().patchMessage(channelId, messageId, update),
};

/**
 * Whether a module is on for a guild. Until the guild's modules have loaded, optional behavior
 * defaults to on (the server default); once loaded, a module the server does not list is off.
 * Direct messages have no guild, so every module the server runs is available there.
 */
export function isModuleEnabled(
  modules: readonly GuildModule[] | undefined,
  moduleId: string,
  inGuild = true,
): boolean {
  if (!inGuild || !modules) return true;
  return modules.find((module) => module.id === moduleId)?.enabled ?? false;
}

export function enabledWebModules(
  list: readonly WebModule[],
  modules: readonly GuildModule[] | undefined,
  inGuild = true,
): WebModule[] {
  return list.filter((module) => isModuleEnabled(modules, module.id, inGuild));
}

/** Applies a module frame from the socket to the store; unknown or malformed frames are dropped. */
export function routeModuleFrame(
  frame: ModuleFrame,
  list: readonly WebModule[] = webModules,
  target: ModuleStoreApi = store,
): boolean {
  for (const module of list) {
    const def = module.frames?.find((candidate) => candidate.type === frame.type);
    if (!def) continue;
    const parsed = def.schema.safeParse(frame);
    if (!parsed.success) return false;
    def.reduce(parsed.data, target);
    return true;
  }
  return false;
}
