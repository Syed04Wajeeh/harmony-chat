import type { Kysely } from 'kysely';
import type {
  CommandDefinition,
  CommandOption,
  DirectoryUser,
  GuildCommand,
} from '@harmony/shared';
import type { BotPrincipal } from '../bots/auth.js';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import { toGuildCommand, type BuiltinCommands } from '../modules/builtin-commands.js';
import type { GuildModuleState } from '../modules/guild-state.js';

/** Per-guild slash command definitions, registered by a bot or its owner. */
export class CommandRegistry {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly builtins: BuiltinCommands,
    private readonly moduleState: GuildModuleState,
  ) {}

  /**
   * Bulk overwrite: afterwards the bot's commands in the guild are exactly `definitions`.
   * A bot may only register its own commands; a human must own the bot.
   */
  async replace(
    actor: DirectoryUser,
    principal: BotPrincipal | null,
    botId: string,
    guildId: string,
    definitions: readonly CommandDefinition[],
  ): Promise<CommandDefinition[]> {
    if (principal) {
      if (principal.id !== botId) {
        throw new AppError(403, 'forbidden', 'A bot can only register its own commands');
      }
    } else {
      const bot = await this.db
        .selectFrom('users')
        .select('bot_owner_id')
        .where('id', '=', botId)
        .where('kind', '=', 'bot')
        .executeTakeFirst();
      if (bot?.bot_owner_id !== actor.id) throw new AppError(404, 'bot_not_found', 'Bot not found');
    }

    const member = await this.db
      .selectFrom('guild_members')
      .select('user_id')
      .where('guild_id', '=', guildId)
      .where('user_id', '=', botId)
      .executeTakeFirst();
    if (!member) throw new AppError(409, 'bot_not_in_guild', 'Add the bot to the guild first');

    const names = definitions.map((definition) => definition.name);
    const reserved = names.find((name) => this.builtins.isReserved(name));
    if (reserved) {
      throw new AppError(409, 'command_conflict', `/${reserved} is a built-in command`);
    }
    await this.db.transaction().execute(async (trx) => {
      if (names.length > 0) {
        const taken = await trx
          .selectFrom('bot_commands')
          .select('name')
          .where('guild_id', '=', guildId)
          .where('bot_id', '!=', botId)
          .where('name', 'in', names)
          .execute();
        if (taken.length > 0) {
          throw new AppError(
            409,
            'command_conflict',
            `Another bot already registered /${taken[0]?.name ?? ''} in this guild`,
          );
        }
      }
      await trx
        .deleteFrom('bot_commands')
        .where('bot_id', '=', botId)
        .where('guild_id', '=', guildId)
        .$if(names.length > 0, (qb) => qb.where('name', 'not in', names))
        .execute();
      for (const definition of definitions) {
        await trx
          .insertInto('bot_commands')
          .values({
            bot_id: botId,
            guild_id: guildId,
            name: definition.name,
            description: definition.description,
            options: JSON.stringify(definition.options),
          })
          .onConflict((oc) =>
            oc.columns(['guild_id', 'name']).doUpdateSet((eb) => ({
              description: eb.ref('excluded.description'),
              options: eb.ref('excluded.options'),
            })),
          )
          .execute();
      }
    });
    return [...definitions];
  }

  /**
   * What members see for autocomplete: the built-in commands of the modules that are on in the
   * guild, then the bots' commands (one that shares a built-in's name stays hidden, as the
   * built-in is what runs).
   */
  async list(actor: Pick<DirectoryUser, 'id'>, guildId: string): Promise<GuildCommand[]> {
    const guild = await this.db
      .selectFrom('guilds')
      .select('id')
      .where('id', '=', guildId)
      .executeTakeFirst();
    if (!guild) throw new AppError(404, 'guild_not_found', 'Guild not found');
    const member = await this.db
      .selectFrom('guild_members')
      .select('user_id')
      .where('guild_id', '=', guildId)
      .where('user_id', '=', actor.id)
      .executeTakeFirst();
    if (!member) throw new AppError(403, 'forbidden', 'You are not a member of this guild');

    const rows = await this.db
      .selectFrom('bot_commands')
      .innerJoin('users', 'users.id', 'bot_commands.bot_id')
      .select([
        'bot_commands.bot_id',
        'users.display_name',
        'bot_commands.name',
        'bot_commands.description',
        'bot_commands.options',
      ])
      .where('bot_commands.guild_id', '=', guildId)
      .execute();
    const enabled = await Promise.all(
      this.builtins
        .all()
        .map(async (command) =>
          (await this.moduleState.isEnabled(guildId, command.moduleId)) ? command : null,
        ),
    );
    const builtin = enabled.flatMap((command) => (command ? [command] : []));
    const shadowed = new Set(builtin.map((command) => command.definition.name));
    return [
      ...builtin.map(toGuildCommand),
      ...rows
        .filter((row) => !shadowed.has(row.name))
        .map((row) => ({
          botId: row.bot_id,
          botName: row.display_name,
          name: row.name,
          description: row.description,
          options: row.options as CommandOption[],
        })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }
}
