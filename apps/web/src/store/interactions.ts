import type { Embed, InteractionFailureReason } from '@harmony/shared';

interface Base {
  /** Unique within the channel; an interaction can have several ephemeral replies. */
  key: string;
  interactionId: string;
  /** Null for built-in commands, which come from a module named by `source`. */
  botId: string | null;
  source?: string;
  command: string;
}

/**
 * Slash command outcomes that only the invoking user sees. They live in client state alone
 * and vanish on reload, which matches what the server does with ephemeral replies.
 */
export type LocalInteraction =
  | (Base & { kind: 'pending'; expiresAt: string })
  | (Base & { kind: 'ephemeral'; content: string; embeds: Embed[] })
  | (Base & { kind: 'failed'; reason: InteractionFailureReason });

/** A final outcome replaces the "thinking" placeholder of the same interaction. */
export function addInteraction(
  list: readonly LocalInteraction[] = [],
  item: LocalInteraction,
): LocalInteraction[] {
  const rest = list.filter(
    (entry) => !(entry.kind === 'pending' && entry.interactionId === item.interactionId),
  );
  return [...rest, item];
}

/** A message from the bot ends its "thinking" placeholders in that channel. */
export function clearPendingFrom(
  list: readonly LocalInteraction[],
  botId: string,
): readonly LocalInteraction[] {
  const next = list.filter((entry) => !(entry.kind === 'pending' && entry.botId === botId));
  return next.length === list.length ? list : next;
}

export function pruneExpired(
  list: readonly LocalInteraction[],
  now: number,
): readonly LocalInteraction[] {
  const next = list.filter(
    (entry) => entry.kind !== 'pending' || Date.parse(entry.expiresAt) > now,
  );
  return next.length === list.length ? list : next;
}
