export const MAX_MENTIONS_PER_MESSAGE = 50;

const MENTION = /<@(\d{1,18})>/g;

/** Distinct user ids in `<@id>` tokens, in order of first appearance. */
export function parseMentions(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(MENTION)) {
    if (match[1]) ids.add(match[1]);
    if (ids.size >= MAX_MENTIONS_PER_MESSAGE) break;
  }
  return [...ids];
}
