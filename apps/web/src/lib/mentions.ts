import type { User } from '@harmony/shared';

/** Display text such as `@Ada` mapped to the user it stands for. */
export type MentionMap = ReadonlyMap<string, string>;

const TOKEN = /<@(\d{1,18})>/g;
const WORD = '[\\p{L}\\p{N}_]';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Turns `<@id>` tokens into `@Name` for editing; unknown ids stay as tokens. */
export function decodeMentions(
  wire: string,
  nameOf: (userId: string) => string | undefined,
): { text: string; mentions: Map<string, string> } {
  const mentions = new Map<string, string>();
  const text = wire.replace(TOKEN, (token, id: string) => {
    const name = nameOf(id);
    if (!name) return token;
    mentions.set(`@${name}`, id);
    return `@${name}`;
  });
  return { text, mentions };
}

/** Turns `@Name` (for names chosen from autocomplete) back into `<@id>` tokens. */
export function encodeMentions(text: string, mentions: MentionMap): string {
  if (mentions.size === 0) return text;
  const labels = [...mentions.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`(?<!${WORD})(${labels.join('|')})(?!${WORD})`, 'gu');
  return text.replace(pattern, (label) => `<@${mentions.get(label) ?? ''}>`);
}

export interface MentionQuery {
  /** Index of the `@` in the text. */
  start: number;
  query: string;
}

/** The `@partial` word ending at the caret, if the caret is inside one. */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const match = /(?:^|\s)@([^\s@]{0,32})$/u.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, query };
}

export function suggestUsers<T extends Pick<User, 'displayName'>>(
  users: readonly T[],
  query: string,
  limit = 6,
): T[] {
  const needle = query.toLowerCase();
  const rank = (user: T) => {
    const name = user.displayName.toLowerCase();
    return name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : 2;
  };
  return users
    .filter((user) => rank(user) < 2)
    .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName))
    .slice(0, limit);
}

/** Replaces the partial `@query` with the chosen name and returns the new text and caret. */
export function insertMention(
  text: string,
  { start, query }: MentionQuery,
  displayName: string,
): { text: string; caret: number } {
  const label = `@${displayName} `;
  const end = start + 1 + query.length;
  return { text: text.slice(0, start) + label + text.slice(end), caret: start + label.length };
}
