import {
  MAX_STRING_OPTION_LENGTH,
  validateCommandOptions,
  type CommandOption,
  type GuildCommand,
  type OptionValue,
} from '@harmony/shared';

const SLASH_QUERY = /^\/([a-z0-9-]*)$/i;
const SLASH_INVOCATION = /^\/([a-z0-9-]+)\s([\s\S]*)$/i;

/** The command name typed so far when the input is `/` followed by name characters only. */
export function findSlashQuery(text: string): string | null {
  const match = SLASH_QUERY.exec(text);
  return match ? (match[1] ?? '').toLowerCase() : null;
}

/** `/name rest`: the name and what was typed after the first space. */
export function splitSlashInput(text: string): { name: string; rest: string } | null {
  const match = SLASH_INVOCATION.exec(text);
  return match ? { name: (match[1] ?? '').toLowerCase(), rest: match[2] ?? '' } : null;
}

/** Name prefix matches first, then names containing the query, then descriptions. */
export function suggestCommands(
  commands: readonly GuildCommand[],
  query: string,
  limit = 8,
): GuildCommand[] {
  const q = query.toLowerCase();
  const rank = (command: GuildCommand): number => {
    if (command.name.startsWith(q)) return 0;
    if (command.name.includes(q)) return 1;
    if (command.description.toLowerCase().includes(q)) return 2;
    return 3;
  };
  return commands
    .map((command) => ({ command, rank: rank(command) }))
    .filter(({ rank: r }) => r < 3)
    .sort((a, b) => a.rank - b.rank || a.command.name.localeCompare(b.command.name))
    .slice(0, limit)
    .map(({ command }) => command);
}

export type Invocation =
  | { ok: true; options: Record<string, OptionValue> }
  | { ok: false; errors: Record<string, string> };

/** Key for errors that belong to the whole command rather than one option. */
export const FORM_ERROR = '_';

function coerce(option: CommandOption, text: string): OptionValue | { error: string } {
  switch (option.type) {
    case 'string':
      return text.length > MAX_STRING_OPTION_LENGTH
        ? { error: `At most ${String(MAX_STRING_OPTION_LENGTH)} characters` }
        : text;
    case 'integer': {
      const value = Number(text);
      return /^-?\d+$/.test(text) && Number.isSafeInteger(value)
        ? value
        : { error: 'Enter a whole number' };
    }
    case 'boolean':
      return text === 'true' || text === 'false'
        ? text === 'true'
        : { error: 'Choose true or false' };
    case 'user':
    case 'channel':
      return /^\d{1,18}$/.test(text) ? text : { error: 'Choose one from the list' };
  }
}

/** Turns the raw strings from the option fields into typed values, or per-option errors. */
export function buildInvocation(
  command: Pick<GuildCommand, 'options'>,
  raw: Readonly<Record<string, string>>,
): Invocation {
  const errors: Record<string, string> = {};
  const supplied: Record<string, OptionValue> = {};
  for (const option of command.options) {
    const text =
      option.type === 'string' ? (raw[option.name] ?? '') : (raw[option.name] ?? '').trim();
    if (text.trim() === '') {
      if (option.required) errors[option.name] = 'Required';
      continue;
    }
    const value = coerce(option, text);
    if (typeof value === 'object') errors[option.name] = value.error;
    else supplied[option.name] = value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const checked = validateCommandOptions(command.options, supplied);
  return checked.ok
    ? { ok: true, options: checked.values }
    : { ok: false, errors: { [FORM_ERROR]: checked.error } };
}
