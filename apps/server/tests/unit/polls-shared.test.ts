import { describe, expect, it } from 'vitest';
import { CreatePollBody, Poll, PollSettings, splitPollOptions } from '@harmony/shared';

describe('splitPollOptions', () => {
  it('trims and drops blanks', () => {
    expect(splitPollOptions(' tea | coffee ||  | water ')).toEqual(['tea', 'coffee', 'water']);
    expect(splitPollOptions('')).toEqual([]);
  });
});

describe('CreatePollBody', () => {
  const ok = { question: 'Lunch?', options: ['pizza', 'ramen'] };

  it('takes 2 to 10 options and defaults to single choice', () => {
    expect(CreatePollBody.parse(ok)).toEqual({ ...ok, multiple: false });
    expect(CreatePollBody.safeParse({ ...ok, options: ['one'] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => `option ${String(i)}`);
    expect(CreatePollBody.safeParse({ ...ok, options: eleven }).success).toBe(false);
    expect(CreatePollBody.safeParse({ ...ok, options: eleven.slice(0, 10) }).success).toBe(true);
  });

  it('rejects duplicate options regardless of case', () => {
    expect(CreatePollBody.safeParse({ ...ok, options: ['Pizza', 'pizza'] }).success).toBe(false);
  });

  it('rejects a blank question', () => {
    expect(CreatePollBody.safeParse({ ...ok, question: '   ' }).success).toBe(false);
  });
});

describe('Poll and PollSettings', () => {
  it('validates the payload carried by messages', () => {
    const poll = {
      multiple: false,
      closed: false,
      closedAt: null,
      totalVoters: 1,
      options: [{ id: 1, label: 'a', votes: 1, voterIds: ['7'] }],
    };
    expect(Poll.safeParse(poll).success).toBe(true);
    expect(Poll.safeParse({ ...poll, options: 'nope' }).success).toBe(false);
  });

  it('defaults every setting', () => {
    expect(PollSettings.parse({})).toEqual({ allowMultipleChoice: true });
  });
});
