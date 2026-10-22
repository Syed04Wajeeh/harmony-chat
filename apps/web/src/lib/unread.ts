import type { Message } from '@harmony/shared';
import { compareIds } from './ids.js';

/**
 * The id of the first message after the read marker that someone else wrote, or null when
 * there is nothing to mark or the marker lies above what is loaded (so its position is unknown).
 */
export function firstUnreadId(
  messages: readonly Message[],
  lastReadId: string | null,
  meId: string,
  hasMoreAbove: boolean,
): string | null {
  if (lastReadId === null) return null;
  const first = messages[0];
  if (!first) return null;
  if (hasMoreAbove && compareIds(first.id, lastReadId) > 0) return null;
  const unread = messages.find(
    (message) =>
      compareIds(message.id, lastReadId) > 0 && !message.deleted && message.author.id !== meId,
  );
  return unread?.id ?? null;
}

/** Whether the read marker should advance now. */
export function shouldMarkRead(options: {
  newestId: string | null;
  lastReadId: string | null;
  atBottom: boolean;
  focused: boolean;
}): boolean {
  const { newestId, lastReadId, atBottom, focused } = options;
  if (!newestId || !atBottom || !focused) return false;
  return lastReadId === null || compareIds(newestId, lastReadId) > 0;
}
