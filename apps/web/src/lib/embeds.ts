import type { Embed } from '@harmony/shared';

/** Only http(s) URLs may become links or image sources; anything else is dropped. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Embed colors are 24-bit integers; anything else (missing, negative, fractional) gets no bar color. */
export function embedColor(color: number | undefined): string | null {
  if (color === undefined || !Number.isInteger(color) || color < 0 || color > 0xffffff) return null;
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function hasVisibleContent(embed: Embed): boolean {
  return Boolean(
    embed.title ||
    embed.description ||
    embed.author?.name ||
    embed.footer?.text ||
    embed.timestamp ||
    embed.fields?.length ||
    safeHttpUrl(embed.image?.url) ||
    safeHttpUrl(embed.thumbnail?.url),
  );
}
