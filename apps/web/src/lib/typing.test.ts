import { describe, expect, it } from 'vitest';
import { isValidEmoji } from '@harmony/shared';
import { EMOJI, searchEmoji } from './emoji.js';
import { typingText } from './typing.js';

describe('typingText', () => {
  it.each([
    [[], ''],
    [['Ada'], 'Ada is typing…'],
    [['Ada', 'Linus'], 'Ada and Linus are typing…'],
    [['Ada', 'Linus', 'Grace'], 'Several people are typing…'],
  ])('%j', (names, expected) => expect(typingText(names)).toBe(expected));
});

describe('emoji set', () => {
  it('has about sixty emoji that the server accepts', () => {
    expect(EMOJI.length).toBeGreaterThanOrEqual(55);
    expect(EMOJI.filter((e) => !isValidEmoji(e.emoji))).toEqual([]);
    expect(new Set(EMOJI.map((e) => e.emoji)).size).toBe(EMOJI.length);
  });
  it('searches by name and keyword', () => {
    expect(searchEmoji('heart').map((e) => e.emoji)).toContain('❤️');
    expect(searchEmoji('lol').map((e) => e.emoji)).toContain('😂');
    expect(searchEmoji('zzzzzz')).toEqual([]);
  });
});
