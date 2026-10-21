export const MAX_REACTIONS_PER_MESSAGE = 20;

const SHORTCODE = /^:[a-z0-9_]{2,32}:$/;
const PICTOGRAPH = /^\p{Extended_Pictographic}️?$/u;
// The `v` flag is ES2024; building the pattern at runtime keeps the ES2023 compile target.
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** A single Unicode emoji (one grapheme) or a `:custom_name:` shortcode. */
export function isValidEmoji(value: string): boolean {
  if (SHORTCODE.test(value)) return true;
  if (value.length === 0 || value.length > 32) return false;
  const graphemes = [...segmenter.segment(value)];
  if (graphemes.length !== 1) return false;
  return RGI_EMOJI.test(value) || PICTOGRAPH.test(value);
}
