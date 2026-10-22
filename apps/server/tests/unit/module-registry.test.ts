import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activeModules, sortModules, ModuleError } from '../../src/modules/registry.js';
import { defineModule } from '../../src/modules/types.js';
import { modules as shipped } from '../../src/modules/index.js';

const make = (id: string, dependsOn: string[] = [], extra: object = {}) =>
  defineModule({
    id,
    name: id,
    description: id,
    optional: true,
    dependsOn,
    register: () => undefined,
    ...extra,
  });

const ids = (list: readonly { id: string }[]) => list.map((module) => module.id);

describe('sortModules', () => {
  it('keeps the listed order when nothing depends on anything', () => {
    expect(ids(sortModules([make('b'), make('a'), make('c')]))).toEqual(['b', 'a', 'c']);
  });

  it('puts dependencies first, whatever the listed order', () => {
    const sorted = sortModules([make('c', ['b']), make('b', ['a']), make('a')]);
    expect(ids(sorted)).toEqual(['a', 'b', 'c']);
  });

  it('names the cycle', () => {
    expect(() => sortModules([make('a', ['b']), make('b', ['c']), make('c', ['a'])])).toThrow(
      /cycle: a -> b -> c -> a/i,
    );
  });

  it('rejects a missing dependency', () => {
    expect(() => sortModules([make('a', ['ghost'])])).toThrow(
      /"a" depends on unknown module "ghost"/,
    );
  });

  it('rejects duplicate, malformed and reserved ids', () => {
    expect(() => sortModules([make('a'), make('a')])).toThrow(/listed twice/);
    expect(() => sortModules([make('Not_Kebab')])).toThrow(/kebab-case/);
    expect(() => sortModules([make('reaction')])).toThrow(/reserved/);
  });

  it('requires every guild setting to have a default', () => {
    const strict = z.object({ limit: z.number() });
    expect(() => sortModules([make('a', [], { guildSettings: strict })])).toThrow(
      /needs a default/,
    );
    const lenient = z.object({ limit: z.number().default(3) });
    expect(() => sortModules([make('a', [], { guildSettings: lenient })])).not.toThrow();
  });

  it('accepts the modules this build ships', () => {
    const sorted = ids(sortModules(shipped));
    expect(sorted).toEqual(
      expect.arrayContaining(['uploads', 'reactions', 'pins', 'search', 'polls']),
    );
  });
});

describe('activeModules', () => {
  it('drops the disabled ones', () => {
    expect(ids(activeModules([make('a'), make('b')], ['b']))).toEqual(['a']);
  });

  it('treats an unknown name as a mistake', () => {
    expect(() => activeModules([make('a')], ['typo'])).toThrow(ModuleError);
  });

  it('refuses to disable something a running module needs', () => {
    expect(() => activeModules([make('a'), make('b', ['a'])], ['a'])).toThrow(/"b" needs "a"/);
    expect(ids(activeModules([make('a'), make('b', ['a'])], ['a', 'b']))).toEqual([]);
  });
});
