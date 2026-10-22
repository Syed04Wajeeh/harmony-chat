import { describe, expect, it } from 'vitest';
import {
  decodeMentions,
  encodeMentions,
  findMentionQuery,
  insertMention,
  suggestUsers,
} from './mentions.js';

const names: Record<string, string> = { '1': 'Ada', '2': 'Linus', '3': 'Grace Hopper' };
const nameOf = (id: string) => names[id];

describe('decodeMentions', () => {
  it('turns tokens into @names and records the mapping', () => {
    const { text, mentions } = decodeMentions('hi <@2>, meet <@3>', nameOf);
    expect(text).toBe('hi @Linus, meet @Grace Hopper');
    expect([...mentions]).toEqual([
      ['@Linus', '2'],
      ['@Grace Hopper', '3'],
    ]);
  });

  it('keeps tokens for unknown users', () => {
    expect(decodeMentions('<@99>', nameOf).text).toBe('<@99>');
  });
});

describe('encodeMentions', () => {
  it('round-trips with decode', () => {
    const wire = 'hi <@2>, meet <@3>. <@2> again';
    const { text, mentions } = decodeMentions(wire, nameOf);
    expect(encodeMentions(text, mentions)).toBe(wire);
  });

  it('only matches whole names', () => {
    const mentions = new Map([['@Ada', '1']]);
    expect(encodeMentions('@Adam and @Ada!', mentions)).toBe('@Adam and <@1>!');
    expect(encodeMentions('mail me@Ada', mentions)).toBe('mail me@Ada');
  });

  it('prefers the longest name', () => {
    const mentions = new Map([
      ['@Grace', '3'],
      ['@Grace Hopper', '4'],
    ]);
    expect(encodeMentions('@Grace Hopper hi', mentions)).toBe('<@4> hi');
  });

  it('leaves text alone when the user edited a name away', () => {
    const mentions = new Map([['@Linus', '2']]);
    expect(encodeMentions('@Linu', mentions)).toBe('@Linu');
  });

  it('escapes regex characters in names', () => {
    const mentions = new Map([['@a.b (c)', '7']]);
    expect(encodeMentions('@a.b (c)', mentions)).toBe('<@7>');
    expect(encodeMentions('@aXb (c)', mentions)).toBe('@aXb (c)');
  });
});

describe('findMentionQuery', () => {
  it('finds a partial mention at the caret', () => {
    expect(findMentionQuery('hello @Li', 9)).toEqual({ start: 6, query: 'Li' });
    expect(findMentionQuery('@', 1)).toEqual({ start: 0, query: '' });
  });
  it('ignores emails and finished words', () => {
    expect(findMentionQuery('ada@example', 11)).toBeNull();
    expect(findMentionQuery('@Linus ok', 9)).toBeNull();
  });
  it('only looks before the caret', () => {
    expect(findMentionQuery('@Li later', 3)).toEqual({ start: 0, query: 'Li' });
  });
});

describe('suggestUsers and insertMention', () => {
  const users = [{ displayName: 'Grace' }, { displayName: 'Linus' }, { displayName: 'Ada Lin' }];
  it('ranks prefix matches first', () => {
    expect(suggestUsers(users, 'lin').map((u) => u.displayName)).toEqual(['Linus', 'Ada Lin']);
    expect(suggestUsers(users, '')).toHaveLength(3);
  });
  it('replaces the partial and moves the caret', () => {
    const result = insertMention('hi @Li there', { start: 3, query: 'Li' }, 'Linus');
    expect(result).toEqual({ text: 'hi @Linus  there', caret: 10 });
  });
});
