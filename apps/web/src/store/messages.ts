import type { Message } from '@harmony/shared';
import { compareIds } from '../lib/ids.js';

/** Union by id, ordered by id. Live, backfilled and fetched messages can all overlap. */
export function mergeMessages(
  existing: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

export function tombstone(message: Message): Message {
  return {
    ...message,
    modules: undefined,
    deleted: true,
    content: '',
    attachments: [],
    reactions: [],
    mentions: [],
    replyTo: null,
    pinnedAt: null,
    pinnedBy: null,
  };
}

export function applyDelete(messages: readonly Message[], messageId: string): Message[] {
  return messages.map((message) => {
    if (message.id === messageId) return tombstone(message);
    if (message.replyTo?.id === messageId) {
      return { ...message, replyTo: { ...message.replyTo, deleted: true, contentPreview: '' } };
    }
    return message;
  });
}

export function addReaction(message: Message, emoji: string, userId: string): Message {
  const existing = message.reactions.find((reaction) => reaction.emoji === emoji);
  if (existing?.userIds.includes(userId)) return message;
  const reactions = existing
    ? message.reactions.map((reaction) =>
        reaction === existing
          ? { ...reaction, count: reaction.count + 1, userIds: [...reaction.userIds, userId] }
          : reaction,
      )
    : [...message.reactions, { emoji, count: 1, userIds: [userId] }];
  return { ...message, reactions };
}

export function removeReaction(message: Message, emoji: string, userId: string): Message {
  const existing = message.reactions.find((reaction) => reaction.emoji === emoji);
  if (!existing) return message;
  const count = existing.count - 1;
  const reactions =
    count <= 0
      ? message.reactions.filter((reaction) => reaction !== existing)
      : message.reactions.map((reaction) =>
          reaction === existing
            ? { ...reaction, count, userIds: reaction.userIds.filter((id) => id !== userId) }
            : reaction,
        );
  return { ...message, reactions };
}

/** Maps one message by id, leaving the array untouched when nothing changes. */
export function updateMessage(
  messages: readonly Message[],
  messageId: string,
  update: (message: Message) => Message,
): readonly Message[] {
  const index = messages.findIndex((message) => message.id === messageId);
  const current = messages[index];
  if (!current) return messages;
  const next = update(current);
  if (next === current) return messages;
  return messages.with(index, next);
}
