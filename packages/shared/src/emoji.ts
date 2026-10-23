export const MAX_REACTIONS_PER_MESSAGE = 20;
/** Jumbo rendering applies to messages made only of emoji, up to this many. */
export const MAX_JUMBO_EMOJI = 27;

const SHORTCODE = /^:[a-z0-9_]{2,32}:$/;
const PICTOGRAPH = /^\p{Extended_Pictographic}️?$/u;
// The `v` flag is ES2024; building the pattern at runtime keeps the ES2023 compile target.
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

const TOKEN_SOURCE = '<(a?):([a-z0-9_]{2,32}):(\\d{1,18})>';
const TOKEN = new RegExp(`^${TOKEN_SOURCE}$`);

export interface CustomEmojiToken {
  animated: boolean;
  name: string;
  id: string;
  raw: string;
}

/** `<:name:id>` or `<a:name:id>`. */
export function parseCustomEmoji(value: string): CustomEmojiToken | null {
  const match = TOKEN.exec(value);
  return match
    ? { animated: match[1] === 'a', name: match[2] ?? '', id: match[3] ?? '', raw: value }
    : null;
}

/** Every custom emoji token in `content`, in order, duplicates included. */
export function findCustomEmoji(content: string): CustomEmojiToken[] {
  if (!content.includes('<')) return [];
  return [...content.matchAll(new RegExp(TOKEN_SOURCE, 'g'))].map((match) => ({
    animated: match[1] === 'a',
    name: match[2] ?? '',
    id: match[3] ?? '',
    raw: match[0],
  }));
}

/** Rewrites each custom emoji token; returning null turns it into plain `:name:` text. */
export function mapCustomEmoji(
  content: string,
  replace: (token: CustomEmojiToken) => string | null,
): string {
  if (!content.includes('<')) return content;
  return content.replace(
    new RegExp(TOKEN_SOURCE, 'g'),
    (raw, a: string, name: string, id: string) =>
      replace({ animated: a === 'a', name, id, raw }) ?? `:${name}:`,
  );
}

function isUnicodeEmoji(value: string): boolean {
  if (value.length === 0 || value.length > 32) return false;
  const graphemes = [...segmenter.segment(value)];
  if (graphemes.length !== 1) return false;
  return RGI_EMOJI.test(value) || PICTOGRAPH.test(value);
}

/**
 * A single Unicode emoji (one grapheme), a custom emoji token, or a `:custom_name:` shortcode
 * (the form older reactions were stored in, still accepted).
 */
export function isValidEmoji(value: string): boolean {
  return SHORTCODE.test(value) || TOKEN.test(value) || isUnicodeEmoji(value);
}

/** True when the message is only emoji (unicode or custom), between 1 and `MAX_JUMBO_EMOJI`. */
export function isJumbo(content: string): boolean {
  const text = content.trim();
  if (text.length === 0) return false;
  let count = 0;
  for (const part of text.split(/\s+/)) {
    let rest = part;
    while (rest.length > 0) {
      const custom = /^<a?:[a-z0-9_]{2,32}:\d{1,18}>/.exec(rest);
      if (custom) {
        rest = rest.slice(custom[0].length);
        count += 1;
        continue;
      }
      const [first] = [...segmenter.segment(rest)];
      if (!first || !isUnicodeEmoji(first.segment)) return false;
      rest = rest.slice(first.segment.length);
      count += 1;
    }
    if (count > MAX_JUMBO_EMOJI) return false;
  }
  return count > 0;
}
