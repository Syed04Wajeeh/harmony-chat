import type { GuildCommand } from '@harmony/shared';
import { describe, expect, it } from 'vitest';
import {
  buildInvocation,
  FORM_ERROR,
  findSlashQuery,
  splitSlashInput,
  suggestCommands,
} from './commands.js';

const command = (name: string, description = `${name} command`): GuildCommand => ({
  botId: '9',
  botName: 'Helper',
  name,
  description,
  options: [],
});

describe('findSlashQuery', () => {
  it('matches a slash at the start followed by name characters only', () => {
    expect(findSlashQuery('/')).toBe('');
    expect(findSlashQuery('/ro')).toBe('ro');
    expect(findSlashQuery('/Roll-2')).toBe('roll-2');
  });

  it('does not match elsewhere or after a space', () => {
    expect(findSlashQuery('hello /roll')).toBeNull();
    expect(findSlashQuery(' /roll')).toBeNull();
    expect(findSlashQuery('/roll 20')).toBeNull();
    expect(findSlashQuery('//')).toBeNull();
    expect(findSlashQuery('')).toBeNull();
  });
});

describe('splitSlashInput', () => {
  it('splits the name from what follows the first space', () => {
    expect(splitSlashInput('/echo hello world')).toEqual({ name: 'echo', rest: 'hello world' });
    expect(splitSlashInput('/echo ')).toEqual({ name: 'echo', rest: '' });
    expect(splitSlashInput('/echo\nmore')).toEqual({ name: 'echo', rest: 'more' });
  });

  it('ignores text that is not a command invocation', () => {
    expect(splitSlashInput('/echo')).toBeNull();
    expect(splitSlashInput('echo hi')).toBeNull();
    expect(splitSlashInput('/ echo')).toBeNull();
  });
});

describe('suggestCommands', () => {
  const commands = [
    command('roll', 'Roll a die'),
    command('poll', 'Start a poll'),
    command('echo', 'Repeat text, even a roll call'),
    command('rollcall'),
    command('group', 'Group things'),
  ];

  it('lists everything for a bare slash, sorted by name', () => {
    expect(suggestCommands(commands, '').map((c) => c.name)).toEqual([
      'echo',
      'group',
      'poll',
      'roll',
      'rollcall',
    ]);
  });

  it('ranks prefix matches before substring and description matches', () => {
    expect(suggestCommands(commands, 'ro').map((c) => c.name)).toEqual([
      'roll',
      'rollcall',
      'group',
      'echo',
    ]);
  });

  it('returns nothing when nothing matches and respects the limit', () => {
    expect(suggestCommands(commands, 'zzz')).toEqual([]);
    expect(suggestCommands(commands, '', 2)).toHaveLength(2);
  });
});

describe('buildInvocation', () => {
  const roll: Pick<GuildCommand, 'options'> = {
    options: [
      { name: 'text', description: 'What', type: 'string', required: true },
      { name: 'sides', description: 'Sides', type: 'integer', required: false },
      { name: 'loud', description: 'Loud', type: 'boolean', required: false },
      { name: 'who', description: 'Who', type: 'user', required: false },
      { name: 'where', description: 'Where', type: 'channel', required: false },
    ],
  };

  it('converts raw strings to typed values and omits blanks', () => {
    expect(
      buildInvocation(roll, { text: 'hi there', sides: '20', loud: 'true', who: '7', where: '' }),
    ).toEqual({ ok: true, options: { text: 'hi there', sides: 20, loud: true, who: '7' } });
  });

  it('requires required options, treating whitespace as empty', () => {
    expect(buildInvocation(roll, { text: '   ' })).toEqual({
      ok: false,
      errors: { text: 'Required' },
    });
    expect(buildInvocation(roll, {})).toMatchObject({ ok: false, errors: { text: 'Required' } });
  });

  it('rejects values of the wrong type, reporting every problem at once', () => {
    const result = buildInvocation(roll, {
      text: 'x',
      sides: '2.5',
      loud: 'yes',
      who: 'ada',
      where: '12a',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        sides: 'Enter a whole number',
        loud: 'Choose true or false',
        who: 'Choose one from the list',
        where: 'Choose one from the list',
      },
    });
  });

  it('accepts negative and zero integers but not unsafe ones', () => {
    expect(buildInvocation(roll, { text: 'x', sides: '-3' })).toMatchObject({
      ok: true,
      options: { sides: -3 },
    });
    expect(buildInvocation(roll, { text: 'x', sides: '0' })).toMatchObject({ ok: true });
    expect(buildInvocation(roll, { text: 'x', sides: '9007199254740993' })).toMatchObject({
      ok: false,
    });
  });

  it('enforces the string length limit', () => {
    const result = buildInvocation(roll, { text: 'a'.repeat(1001) });
    expect(result).toEqual({ ok: false, errors: { text: 'At most 1000 characters' } });
  });

  it('keeps leading and trailing spaces inside string values', () => {
    expect(buildInvocation(roll, { text: '  padded  ' })).toMatchObject({
      ok: true,
      options: { text: '  padded  ' },
    });
  });

  it('works for commands without options', () => {
    expect(buildInvocation({ options: [] }, {})).toEqual({ ok: true, options: {} });
    expect(FORM_ERROR).toBe('_');
  });
});
