import type { Message } from '@harmony/shared';
import { sameSender } from './identity.js';
import { compareIds } from './ids.js';
import { formatDayLabel, isSameDay } from './time.js';

export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type TimelineItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'message'; key: string; message: Message; grouped: boolean };

/** Day separators, the "new messages" divider, and author grouping for a message list. */
export function buildTimeline(
  messages: readonly Message[],
  options: { unreadFromId: string | null; now?: Date; grouping?: boolean },
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let previous: Message | null = null;

  for (const message of messages) {
    const date = new Date(message.createdAt);
    const newDay = !previous || !isSameDay(new Date(previous.createdAt), date);
    if (newDay) {
      items.push({
        kind: 'day',
        key: `day-${message.id}`,
        label: formatDayLabel(message.createdAt, options.now),
      });
    }
    const unreadHere = message.id === options.unreadFromId;
    if (unreadHere) items.push({ kind: 'unread', key: 'unread' });

    const grouped =
      options.grouping !== false &&
      !newDay &&
      !unreadHere &&
      previous !== null &&
      !previous.deleted &&
      !message.deleted &&
      message.replyTo === null &&
      sameSender(previous, message) &&
      date.getTime() - new Date(previous.createdAt).getTime() < GROUP_WINDOW_MS;

    items.push({ kind: 'message', key: message.id, message, grouped });
    previous = message;
  }
  return items;
}

export const newestId = (messages: readonly Message[]): string | null =>
  messages.reduce<string | null>(
    (best, message) => (best === null || compareIds(message.id, best) > 0 ? message.id : best),
    null,
  );
