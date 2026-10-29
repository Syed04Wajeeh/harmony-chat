import { describe, expect, it } from 'vitest';
import { PanelSlug } from '@harmony/shared';
import { Cooldown, Registry, buttonId, slugify } from '../../src/targets.ts';

const games = [
  { id: 'abcd1234', name: 'Core Keeper', suspended: false },
  { id: 'efgh5678', name: 'Valheim (EU)', suspended: false },
  { id: 'ijkl9012', name: 'Dup', suspended: false },
  { id: 'mnop3456', name: 'dup', suspended: false },
  { id: 'qrst7890', name: 'Frozen', suspended: true },
];
const registry = new Registry(
  { control: ['jellyfin', 'immich-server'], status: ['vaultwarden', 'harmony-app1-1'] },
  games,
);

describe('slugify', () => {
  it('lowercases, joins words with underscores and drops accents', () => {
    expect(slugify('Core Keeper')).toBe('core_keeper');
    expect(slugify('  Valheim (EU) ')).toBe('valheim_eu');
    expect(slugify('Café—Server #2')).toBe('cafe_server_2');
    expect(slugify('***')).toBe('');
  });
});

describe('target resolution', () => {
  it('finds a game server by its slug in several spellings', () => {
    for (const input of [
      'core_keeper',
      'Core Keeper',
      'core-keeper',
      'CORE_KEEPER',
      'game:core_keeper',
    ]) {
      expect(registry.resolve(input)).toMatchObject({ kind: 'game', id: 'abcd1234' });
    }
    expect(registry.resolve('valheim_eu')).toMatchObject({ id: 'efgh5678' });
  });

  it('finds containers by exact name or slug, and marks status-only ones as not controllable', () => {
    expect(registry.resolve('jellyfin')).toMatchObject({ kind: 'docker', control: true });
    expect(registry.resolve('immich_server')).toMatchObject({ name: 'immich-server' });
    expect(registry.resolve('vaultwarden')).toMatchObject({ control: false });
  });

  it('rejects unknown, empty, path-like and ambiguous input', () => {
    for (const input of [
      '',
      'portainer',
      '../etc',
      'jellyfin/../x',
      'jelly',
      'frozen',
      'docker:core_keeper',
    ]) {
      expect(() => registry.resolve(input), input).toThrow(/not a target|more than one/);
    }
    // Two servers with one slug are not offered at all.
    expect(() => registry.resolve('dup')).toThrow(/not a target/);
  });

  it('asks for a prefix when a container and a game share a name', () => {
    const both = new Registry({ control: ['valheim'], status: [] }, [
      { id: 'abcd1234', name: 'Valheim', suspended: false },
    ]);
    expect(() => both.resolve('valheim')).toThrow(/more than one/);
    expect(both.resolve('game:valheim')).toMatchObject({ kind: 'game' });
    expect(both.resolve('docker:valheim')).toMatchObject({ kind: 'docker' });
  });

  it('honours a game allowlist and never lists suspended servers', () => {
    const only = new Registry({ control: [], status: [] }, games, ['valheim_eu']);
    expect(only.games.map((g) => g.id)).toEqual(['efgh5678']);
  });
});

describe('button ids', () => {
  it('are valid panel slugs, at most 32 characters, even for long names', () => {
    const long = 'a-very-long-container-name-that-goes-on-and-on-and-on';
    const r = new Registry({ control: [long, 'x'], status: [] }, [
      { id: 'abcd1234', name: 'Some Quite Long Game Server Name Here', suspended: false },
    ]);
    for (const t of r.controllable) {
      for (const verb of ['start', 'stop', 'restart'] as const) {
        const id = buttonId(verb, t);
        expect(id.length).toBeLessThanOrEqual(32);
        expect(PanelSlug.safeParse(id).success, id).toBe(true);
        expect(r.fromButton(id)).toEqual({ verb, target: t });
      }
    }
  });

  it('map only to controllable targets: status-only containers have no button id at all', () => {
    expect(
      registry.fromButton(buttonId('restart', registry.resolve('vaultwarden'))),
    ).toBeUndefined();
    expect(registry.fromButton('rs-jellyfin')).toBeDefined();
    expect(registry.fromButton('rs-harmony-app1-1')).toBeUndefined();
    expect(registry.fromButton('constructor')).toBeUndefined();
    expect(registry.fromButton('__proto__')).toBeUndefined();
  });

  it('refuses two targets that would share an id', () => {
    expect(() => new Registry({ control: ['a_b', 'a-b'], status: [] }, [])).toThrow(
      /share the button id/,
    );
  });
});

describe('cooldown', () => {
  it('blocks the same key inside the window, only that key, and releases on request', () => {
    let now = 0;
    const c = new Cooldown(30_000, () => now);
    c.claim('docker:a');
    expect(() => c.claim('docker:a')).toThrow(/try again in 30 s/);
    now = 10_500;
    expect(() => c.claim('docker:a')).toThrow(/try again in 20 s/);
    c.claim('docker:b');
    c.release('docker:a');
    c.claim('docker:a');
    now = 100_000;
    c.claim('docker:a');
  });
});
