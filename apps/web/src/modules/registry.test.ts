import { describe, expect, it, vi } from 'vitest';
import type { GuildModule } from '@harmony/shared';
import { isModuleEnabled, enabledWebModules, routeModuleFrame } from './registry.js';
import { defineFrame, defineWebModule } from './types.js';
import { myVotes, nextVotes, percentOf } from './polls/tally.js';

const mod = (id: string, enabled: boolean): GuildModule => ({
  id,
  name: id,
  description: '',
  optional: true,
  enabled,
  dependsOn: [],
  settings: {},
  settingsSchema: null,
  permissions: [],
});

describe('isModuleEnabled', () => {
  it('is on until the guild’s modules load, and in DMs', () => {
    expect(isModuleEnabled(undefined, 'polls')).toBe(true);
    expect(isModuleEnabled([], 'polls', false)).toBe(true);
  });

  it('follows the loaded state, and treats an unlisted module as off', () => {
    const list = [mod('polls', false), mod('pins', true)];
    expect(isModuleEnabled(list, 'polls')).toBe(false);
    expect(isModuleEnabled(list, 'pins')).toBe(true);
    expect(isModuleEnabled(list, 'search')).toBe(false);
  });

  it('filters web modules', () => {
    const web = [defineWebModule({ id: 'polls' }), defineWebModule({ id: 'pins' })];
    expect(
      enabledWebModules(web, [mod('polls', false), mod('pins', true)]).map((m) => m.id),
    ).toEqual(['pins']);
  });
});

describe('routeModuleFrame', () => {
  const reduce = vi.fn();
  const web = [
    defineWebModule({
      id: 'demo',
      frames: [
        defineFrame({
          type: 'demo.set',
          schema: {
            safeParse: (data: unknown) =>
              typeof (data as { n?: unknown }).n === 'number'
                ? { success: true as const, data }
                : { success: false as const },
          },
          reduce,
        }),
      ],
    }),
  ];
  const store = { patchMessage: vi.fn() };

  it('validates the frame and hands it to the module’s reducer', () => {
    expect(routeModuleFrame({ type: 'demo.set', n: 2 }, web, store)).toBe(true);
    expect(reduce).toHaveBeenCalledWith({ type: 'demo.set', n: 2 }, store);
  });

  it('drops malformed and unknown frames', () => {
    reduce.mockClear();
    expect(routeModuleFrame({ type: 'demo.set', n: 'x' }, web, store)).toBe(false);
    expect(routeModuleFrame({ type: 'demo.other' }, web, store)).toBe(false);
    expect(reduce).not.toHaveBeenCalled();
  });
});

describe('poll tallies', () => {
  const poll = {
    multiple: false,
    closed: false,
    closedAt: null,
    totalVoters: 4,
    options: [
      { id: 1, label: 'a', votes: 3, voterIds: ['1', '2', '3'] },
      { id: 2, label: 'b', votes: 1, voterIds: ['4'] },
    ],
  };

  it('computes percentages of voters and finds my votes', () => {
    expect(poll.options.map((o) => percentOf(o, poll))).toEqual([75, 25]);
    expect(percentOf(poll.options[0]!, { ...poll, totalVoters: 0 })).toBe(0);
    expect(myVotes(poll, '4')).toEqual([2]);
    expect(myVotes(poll, '9')).toEqual([]);
  });

  it('switches or retracts on a single-choice poll, toggles on multiple', () => {
    expect(nextVotes(poll, [1], 2)).toEqual([2]);
    expect(nextVotes(poll, [1], 1)).toEqual([]);
    const multi = { ...poll, multiple: true };
    expect(nextVotes(multi, [1], 2)).toEqual([1, 2]);
    expect(nextVotes(multi, [1, 2], 1)).toEqual([2]);
  });
});
