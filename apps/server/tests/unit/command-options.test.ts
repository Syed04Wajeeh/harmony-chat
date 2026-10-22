import { describe, expect, it } from 'vitest';
import {
  CommandDefinition,
  PutCommandsBody,
  validateCommandOptions,
  type CommandOption,
} from '@harmony/shared';

const options: CommandOption[] = [
  { name: 'text', description: 'Text', type: 'string', required: true },
  { name: 'count', description: 'Count', type: 'integer', required: false },
  { name: 'loud', description: 'Loud', type: 'boolean', required: false },
  { name: 'who', description: 'Who', type: 'user', required: false },
  { name: 'where', description: 'Where', type: 'channel', required: false },
];

describe('command definitions', () => {
  it('accepts valid commands and defaults options and required', () => {
    const parsed = CommandDefinition.parse({
      name: 'roll',
      description: 'Roll a die',
      options: [{ name: 'sides', description: 'Sides', type: 'integer' }],
    });
    expect(parsed.options[0]?.required).toBe(false);
    expect(CommandDefinition.parse({ name: 'ping', description: 'Ping' }).options).toEqual([]);
  });

  it.each([
    { name: 'Roll', description: 'x' },
    { name: '', description: 'x' },
    { name: 'a'.repeat(33), description: 'x' },
    { name: 'with space', description: 'x' },
    { name: 'ok', description: 'd'.repeat(101) },
    { name: 'ok', description: '' },
    {
      name: 'ok',
      description: 'x',
      options: Array.from({ length: 11 }, (_, i) => ({
        name: `o${i}`,
        description: 'x',
        type: 'string',
      })),
    },
    { name: 'ok', description: 'x', options: [{ name: 'a', description: 'x', type: 'float' }] },
    {
      name: 'ok',
      description: 'x',
      options: [
        { name: 'a', description: 'x', type: 'string' },
        { name: 'a', description: 'y', type: 'string' },
      ],
    },
  ])('rejects %j', (definition) => {
    expect(CommandDefinition.safeParse(definition).success).toBe(false);
  });

  it('allows ten options and rejects duplicate command names', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      name: `o${i}`,
      description: 'x',
      type: 'string',
    }));
    expect(
      CommandDefinition.safeParse({ name: 'ok', description: 'x', options: ten }).success,
    ).toBe(true);
    const dup = [
      { name: 'a', description: 'x' },
      { name: 'a', description: 'y' },
    ];
    expect(PutCommandsBody.safeParse(dup).success).toBe(false);
  });
});

describe('command option validation', () => {
  it('accepts a complete, correctly typed set', () => {
    const result = validateCommandOptions(options, {
      text: 'hi',
      count: 3,
      loud: true,
      who: '12',
      where: '34',
    });
    expect(result).toEqual({
      ok: true,
      values: { text: 'hi', count: 3, loud: true, who: '12', where: '34' },
    });
  });

  it('allows omitting optional options', () => {
    expect(validateCommandOptions(options, { text: 'hi' })).toEqual({
      ok: true,
      values: { text: 'hi' },
    });
  });

  it('requires required options', () => {
    expect(validateCommandOptions(options, {})).toMatchObject({ ok: false });
  });

  it('rejects unknown options', () => {
    expect(validateCommandOptions(options, { text: 'hi', extra: 1 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('extra') as string,
    });
  });

  it.each([
    [{ text: 5 }],
    [{ text: 'x'.repeat(1001) }],
    [{ text: 'a', count: 1.5 }],
    [{ text: 'a', count: '3' }],
    [{ text: 'a', count: Number.MAX_SAFE_INTEGER + 2 }],
    [{ text: 'a', loud: 'yes' }],
    [{ text: 'a', who: 'alice' }],
    [{ text: 'a', who: 12 }],
    [{ text: 'a', where: '12abc' }],
  ])('rejects wrongly typed input %j', (input) => {
    expect(validateCommandOptions(options, input).ok).toBe(false);
  });

  it('accepts a 1000 character string and negative integers', () => {
    expect(validateCommandOptions(options, { text: 'x'.repeat(1000), count: -4 }).ok).toBe(true);
  });
});
