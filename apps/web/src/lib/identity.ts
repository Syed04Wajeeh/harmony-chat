import type { Message, User } from '@harmony/shared';

export type AuthorBadgeKind = 'bot' | 'webhook';

export interface MessageIdentity {
  name: string;
  /** The author with any per-message name and avatar applied. */
  avatarUser: User;
  badge: AuthorBadgeKind | null;
}

/** Webhook callers may name and dress each message; everything else shows the author as is. */
export function messageIdentity(
  message: Pick<
    Message,
    'author' | 'authorNickname' | 'webhookId' | 'displayNameOverride' | 'avatarUrlOverride'
  >,
  /** The author's current nickname in the guild; falls back to the one the message carried. */
  nickname?: string | null,
): MessageIdentity {
  const { author } = message;
  const nick = nickname !== undefined ? nickname : message.authorNickname;
  const name =
    message.displayNameOverride || (message.webhookId ? null : nick) || author.displayName;
  return {
    name,
    avatarUser: {
      ...author,
      displayName: name,
      avatarUrl: message.avatarUrlOverride || author.avatarUrl,
    },
    badge: message.webhookId ? 'webhook' : author.isBot ? 'bot' : null,
  };
}

/** Consecutive messages only share a header when they look like they came from the same sender. */
export function sameSender(a: Message, b: Message): boolean {
  return (
    a.author.id === b.author.id &&
    (a.displayNameOverride ?? null) === (b.displayNameOverride ?? null) &&
    (a.avatarUrlOverride ?? null) === (b.avatarUrlOverride ?? null)
  );
}
