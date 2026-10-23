import { searchEmoji } from './emoji.js';

export interface EmojiQuery {
  /** Index of the colon in the text. */
  start: number;
  query: string;
}

export interface EmojiSuggestion {
  key: string;
  /** What goes into the message: a Unicode character or a `<:name:id>` token. */
  value: string;
  label: string;
  custom?: { id: string; name: string };
}

export interface CustomChoice {
  id: string;
  name: string;
  animated: boolean;
}

/** The `:partial` word ending at the caret, once it has at least two characters. */
export function findEmojiQuery(text: string, caret: number): EmojiQuery | null {
  const match = /(?:^|\s):([a-z0-9_]{2,32})$/i.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, query };
}

const shortcode = (name: string) => name.trim().toLowerCase().replaceAll(' ', '_');

/** Custom emoji first (they are what people typed a colon for), then Unicode. */
export function suggestEmoji(
  query: string,
  custom: readonly CustomChoice[],
  limit = 8,
): EmojiSuggestion[] {
  const needle = query.toLowerCase();
  const own = custom
    .filter((emoji) => emoji.name.includes(needle))
    .sort((a, b) => Number(b.name.startsWith(needle)) - Number(a.name.startsWith(needle)))
    .map((emoji) => ({
      key: `c${emoji.id}`,
      value: `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`,
      label: `:${emoji.name}:`,
      custom: { id: emoji.id, name: emoji.name },
    }));
  const unicode = searchEmoji(needle.replaceAll('_', ' '))
    .filter((entry) => shortcode(entry.name).includes(needle) || entry.keywords?.includes(needle))
    .map((entry) => ({
      key: entry.emoji,
      value: entry.emoji,
      label: `:${shortcode(entry.name)}:`,
    }));
  return [...own, ...unicode].slice(0, limit);
}

export function replaceEmojiQuery(
  text: string,
  { start, query }: EmojiQuery,
  value: string,
): { text: string; caret: number } {
  const label = `${value} `;
  const end = start + 1 + query.length;
  return { text: text.slice(0, start) + label + text.slice(end), caret: start + label.length };
}
