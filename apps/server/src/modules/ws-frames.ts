import type { z } from 'zod';
import { MODULE_FRAME_TYPE, type BotScope } from '@harmony/shared';
import { ModuleError } from './registry.js';
import type { WsCaller } from './types.js';

export interface WsFrameHandler {
  moduleId: string;
  schema: z.ZodType;
  scope: BotScope | undefined;
  run(frame: unknown, caller: WsCaller): void | Promise<void>;
}

/** Client-to-server frame types contributed by modules. Anything not listed is still an error. */
export class ModuleFrames {
  private readonly handlers = new Map<string, WsFrameHandler>();

  register(moduleId: string, type: string, handler: Omit<WsFrameHandler, 'moduleId'>): void {
    if (!MODULE_FRAME_TYPE.test(type) || !type.startsWith(`${moduleId}.`)) {
      throw new ModuleError(`Frame "${type}" must be named "${moduleId}.<name>"`);
    }
    if (this.handlers.has(type)) throw new ModuleError(`Frame "${type}" is registered twice`);
    this.handlers.set(type, { moduleId, ...handler });
  }

  /** Validates a raw frame against its module's schema; null when the type is not a module's. */
  parse(raw: unknown): { handler: WsFrameHandler; frame: unknown } | null | 'invalid' {
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof type !== 'string') return null;
    const handler = this.handlers.get(type);
    if (!handler) return null;
    const result = handler.schema.safeParse(raw);
    return result.success ? { handler, frame: result.data } : 'invalid';
  }
}
