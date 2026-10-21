import { describe, expect, it } from 'vitest';
import { isValidEmoji } from '@harmony/shared';

describe('isValidEmoji', () => {
  it.each([
    '👍',
    '😀',
    '❤️',
    '🇩🇪',
    '👨‍👩‍👧',
    '🏳️‍🌈',
    '👍🏽',
    '1️⃣',
    '🔥',
    '©️',
    ':party_parrot:',
    ':ok:',
    ':a_b_2:',
  ])('accepts %s', (value) => {
    expect(isValidEmoji(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['letter', 'a'],
    ['digit', '1'],
    ['text', 'hello'],
    ['two emoji', '👍👍'],
    ['emoji plus text', '👍x'],
    ['shortcode too short', ':a:'],
    ['shortcode uppercase', ':Party:'],
    ['shortcode with space', ':big deal:'],
    ['shortcode too long', `:${'a'.repeat(33)}:`],
    ['unterminated shortcode', ':party'],
    ['markup', '<b>'],
    ['zero-width joiner alone', '\u200d'],
    ['very long', '👍'.repeat(40)],
  ])('rejects %s', (_name, value) => {
    expect(isValidEmoji(value)).toBe(false);
  });
});
