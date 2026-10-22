import { describe, expect, it } from 'vitest';
import { message, user } from '../test/factories.js';
import { buildTimeline } from './timeline.js';
import { firstUnreadId, shouldMarkRead } from './unread.js';

const msgs = [message('10'), message('11'), message('12'), message('13')];

describe('firstUnreadId', () => {
  it('points at the first message after the read marker', () => {
    expect(firstUnreadId(msgs, '11', '1', false)).toBe('12');
  });
  it('skips my own and deleted messages', () => {
    const list = [
      message('10'),
      message('11', { author: user('1') }),
      message('12', { deleted: true }),
      message('13'),
    ];
    expect(firstUnreadId(list, '10', '1', false)).toBe('13');
  });
  it('is null when everything is read, or there is no marker', () => {
    expect(firstUnreadId(msgs, '13', '1', false)).toBeNull();
    expect(firstUnreadId(msgs, null, '1', false)).toBeNull();
    expect(firstUnreadId([], '1', '1', false)).toBeNull();
  });
  it('is null when the marker is above the loaded window', () => {
    expect(firstUnreadId(msgs, '5', '1', true)).toBeNull();
    expect(firstUnreadId(msgs, '5', '1', false)).toBe('10');
  });
  it('compares ids numerically', () => {
    const list = [message('99'), message('100')];
    expect(firstUnreadId(list, '99', '1', false)).toBe('100');
  });
});

describe('shouldMarkRead', () => {
  const base = { newestId: '12', lastReadId: '10', atBottom: true, focused: true };
  it('marks when at the bottom, focused and behind', () => {
    expect(shouldMarkRead(base)).toBe(true);
  });
  it.each([
    { atBottom: false },
    { focused: false },
    { newestId: null },
    { lastReadId: '12' },
    { lastReadId: '100' },
  ])('does not mark for %j', (change) => {
    expect(shouldMarkRead({ ...base, ...change })).toBe(false);
  });
});

describe('buildTimeline', () => {
  const at = (iso: string) => ({ createdAt: iso });
  const now = new Date('2026-10-22T12:00:00Z');

  it('groups the same author within five minutes', () => {
    const items = buildTimeline(
      [
        message('1', at('2026-10-22T09:00:00Z')),
        message('2', at('2026-10-22T09:04:00Z')),
        message('3', at('2026-10-22T09:10:00Z')),
        message('4', { ...at('2026-10-22T09:11:00Z'), author: user('3') }),
      ],
      { unreadFromId: null, now },
    );
    const grouped = items.flatMap((i) => (i.kind === 'message' ? [i.grouped] : []));
    expect(grouped).toEqual([false, true, false, false]);
  });

  it('inserts day separators and breaks groups across days', () => {
    const items = buildTimeline(
      [message('1', at('2026-10-21T23:59:00Z')), message('2', at('2026-10-22T00:01:00Z'))],
      { unreadFromId: null, now },
    );
    expect(items.filter((i) => i.kind === 'day')).toHaveLength(2);
  });

  it('places the unread divider before the message and never groups across it', () => {
    const items = buildTimeline([message('1'), message('2')], { unreadFromId: '2', now });
    expect(items.map((i) => i.kind)).toEqual(['day', 'message', 'unread', 'message']);
    const last = items.at(-1);
    expect(last?.kind === 'message' && last.grouped).toBe(false);
  });

  it('does not group replies or tombstones', () => {
    const items = buildTimeline(
      [
        message('1'),
        message('2', { replyTo: { id: '1', authorId: '2', contentPreview: 'x', deleted: false } }),
        message('3', { deleted: true }),
        message('4'),
      ],
      { unreadFromId: null, now },
    );
    const grouped = items.flatMap((i) => (i.kind === 'message' ? [i.grouped] : []));
    expect(grouped).toEqual([false, false, false, false]);
  });
});
