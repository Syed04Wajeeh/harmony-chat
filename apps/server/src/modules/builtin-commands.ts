import { CommandDefinition, type GuildCommand } from '@harmony/shared';
import { ModuleError } from './registry.js';
import type { BuiltinCommand } from './types.js';

export interface RegisteredCommand {
  moduleId: string;
  moduleName: string;
  definition: CommandDefinition;
  handler: BuiltinCommand['handler'];
}

/**
 * Slash commands that modules answer in-process. They share one namespace with bot commands:
 * a built-in name is reserved (bots cannot register it) and wins at invocation, but only in
 * guilds where its module is enabled; elsewhere the name is free for a bot.
 */
export class BuiltinCommands {
  private readonly commands = new Map<string, RegisteredCommand>();

  register(moduleId: string, moduleName: string, command: BuiltinCommand): void {
    const definition = CommandDefinition.parse({
      name: command.name,
      description: command.description,
      options: command.options ?? [],
    });
    const existing = this.commands.get(definition.name);
    if (existing) {
      throw new ModuleError(
        `Command /${definition.name} is registered by both "${existing.moduleId}" and "${moduleId}"`,
      );
    }
    this.commands.set(definition.name, {
      moduleId,
      moduleName,
      definition,
      handler: command.handler,
    });
  }

  get(name: string): RegisteredCommand | undefined {
    return this.commands.get(name);
  }

  isReserved(name: string): boolean {
    return this.commands.has(name);
  }

  all(): RegisteredCommand[] {
    return [...this.commands.values()];
  }
}

/** The entry shown in autocomplete. */
export function toGuildCommand(command: RegisteredCommand): GuildCommand {
  return {
    ...command.definition,
    botId: null,
    botName: command.moduleName,
    moduleId: command.moduleId,
  };
}
