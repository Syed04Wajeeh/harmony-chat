import type { ChannelSummary, Me, Message, User } from '@harmony/shared';

export const user = (id: string, displayName = `User ${id}`): User => ({
  id,
  login: `${displayName.toLowerCase().replace(/\s+/g, '')}@example.com`,
  displayName,
  avatarUrl: null,
});

export const me: Me = { ...user('1', 'Ada'), isAdmin: false, status: 'online' };

export function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    channelId: '10',
    author: user('2', 'Linus'),
    content: `message ${id}`,
    createdAt: '2026-10-22T09:00:00.000Z',
    editedAt: null,
    deleted: false,
    pinnedAt: null,
    pinnedBy: null,
    replyTo: null,
    reactions: [],
    attachments: [],
    mentions: [],
    ...overrides,
  };
}

export function channel(id: string, overrides: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id,
    guildId: '5',
    kind: 'text',
    name: `channel-${id}`,
    topic: null,
    isPrivate: false,
    createdBy: '1',
    dmUser: null,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    lastReadMessageId: null,
    ...overrides,
  };
}
