import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

/**
 * Adds data for a batch of messages that carry the module's marker. Runs on the executor the
 * messages were read with, so it also sees rows written in the same transaction.
 */
export type MessageDecorator = (
  messageIds: string[],
  db: Kysely<Database>,
) => Promise<Map<string, unknown>>;

/** The decorators modules registered, by module id. Empty unless a module adds one. */
export class MessageDecorators {
  private readonly byModule = new Map<string, MessageDecorator>();

  register(moduleId: string, decorator: MessageDecorator): void {
    if (this.byModule.has(moduleId)) {
      throw new Error(`Module "${moduleId}" already registered a message decorator`);
    }
    this.byModule.set(moduleId, decorator);
  }

  get(moduleId: string): MessageDecorator | undefined {
    return this.byModule.get(moduleId);
  }
}
