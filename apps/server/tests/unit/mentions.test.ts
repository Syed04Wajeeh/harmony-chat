import { describe, expect, it } from 'vitest';
import { MAX_MENTIONS_PER_MESSAGE, parseMentions } from '@harmony/shared';

describe('parseMentions', () => {
  it('extracts distinct user ids in order of first appearance', () => {
    expect(parseMentions('hi <@12> and <@7>, again <@12>')).toEqual(['12', '7']);
  });

  it('ignores malformed tokens', () => {
    expect(parseMentions('<@abc> <@> <@12 @12> <@ 12> <12> <@@12> <@1234567890123456789>')).toEqual(
      [],
    );
  });

  it('finds tokens adjacent to text and each other', () => {
    expect(parseMentions('a<@1>b<@2><@3>')).toEqual(['1', '2', '3']);
  });

  it('returns nothing for plain text', () => {
    expect(parseMentions('no mentions here, just an email a@b.c')).toEqual([]);
  });

  it('caps the number of mentions per message', () => {
    const content = Array.from({ length: 200 }, (_, i) => `<@${i + 1}>`).join(' ');
    expect(parseMentions(content)).toHaveLength(MAX_MENTIONS_PER_MESSAGE);
  });
});
