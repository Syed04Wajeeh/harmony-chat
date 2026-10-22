import { z } from 'zod';
import { Id } from './chat.js';

/** Module ids are kebab-case; they also namespace the module's frames (`polls.updated`). */
export const ModuleId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'Use lowercase letters, digits and hyphens')
  .max(32);

/** Prefixes the core protocol uses for its own frames; no module may take them as an id. */
export const RESERVED_MODULE_IDS: readonly string[] = [
  'ack',
  'backfill',
  'channel',
  'command',
  'error',
  'guild',
  'hello',
  'interaction',
  'mention',
  'message',
  'presence',
  'reaction',
  'read',
  'subscribe',
  'typing',
  'unsubscribe',
];

const JsonObject = z.record(z.string(), z.unknown());

/** Frames from modules are `<moduleId>.<name>` plus whatever fields the module defines. */
export const MODULE_FRAME_TYPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9_]*$/;
export const ModuleFrame = z.looseObject({ type: z.string().regex(MODULE_FRAME_TYPE) });
export type ModuleFrame = z.infer<typeof ModuleFrame>;

export const PermissionDefinition = z.object({ key: z.string(), description: z.string() });
export type PermissionDefinition = z.infer<typeof PermissionDefinition>;

export const GuildModule = z.object({
  id: ModuleId,
  name: z.string(),
  description: z.string(),
  /** Optional modules can be switched off per guild; the rest are always on. */
  optional: z.boolean(),
  enabled: z.boolean(),
  dependsOn: z.array(ModuleId),
  settings: JsonObject,
  /** JSON Schema of `settings`, or null when the module has none. */
  settingsSchema: JsonObject.nullable(),
  permissions: z.array(PermissionDefinition),
});
export type GuildModule = z.infer<typeof GuildModule>;

export const GuildModulesResponse = z.object({ modules: z.array(GuildModule) });
export type GuildModulesResponse = z.infer<typeof GuildModulesResponse>;

export const GuildModuleParams = z.object({ id: Id, moduleId: ModuleId });

export const UpdateGuildModuleBody = z
  .object({ enabled: z.boolean().optional(), settings: JsonObject.optional() })
  .refine((body) => body.enabled !== undefined || body.settings !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateGuildModuleBody = z.infer<typeof UpdateGuildModuleBody>;
