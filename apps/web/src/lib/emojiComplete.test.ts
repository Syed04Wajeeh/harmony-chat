import { describe, expect, it } from 'vitest';
import { findEmojiQuery, replaceEmojiQuery, suggestEmoji } from './emojiComplete.js';

describe('emoji autocomplete', () => {
  it('needs a colon and two characters at a word start', () => {
    expect(findEmojiQuery(':s', 2)).toBeNull();
    expect(findEmojiQuery('hi :sm', 6)).toEqual({ start: 3, query: 'sm' });
    expect(findEmojiQuery('time 10:30', 10)).toBeNull();
    expect(findEmojiQuery('hi :sm and', 6)).toEqual({ start: 3, query: 'sm' });
  });

  it('suggests custom emoji before Unicode ones', () => {
    const found = suggestEmoji('fire', [{ id: '7', name: 'firefly', animated: true }]);
    expect(found[0]).toMatchObject({ value: '<a:firefly:7>', label: ':firefly:' });
    expect(found.some((item) => item.value === '🔥')).toBe(true);
  });

  it('replaces the partial word with the choice', () => {
    expect(replaceEmojiQuery('hi :fi', { start: 3, query: 'fi' }, '🔥')).toEqual({
      text: 'hi 🔥 ',
      caret: 6,
    });
  });
});
