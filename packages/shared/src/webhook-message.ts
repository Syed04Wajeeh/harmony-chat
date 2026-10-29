import { EMBED_LIMITS, type Embed } from './embeds.js';
import { MAX_WEBHOOK_CONTENT, stripMassMentions } from './webhook-format.js';

/** What a preset or template produces once `normalizeMessage` has made it safe to post. */
export interface WebhookMessage {
  content: string;
  embeds: Embed[];
  username?: string;
}

/** An embed before clamping: any field may be too long, empty or malformed. */
export interface LooseEmbed {
  title?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  color?: number | undefined;
  timestamp?: string | undefined;
  fields?: { name: string; value: string; inline?: boolean | undefined }[] | undefined;
  footer?: string | undefined;
  author?: string | undefined;
}

export interface LooseMessage {
  content?: string | undefined;
  embeds?: LooseEmbed[] | undefined;
  username?: string | undefined;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  // Do not cut a surrogate pair in half.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

const clean = (text: string | undefined, max: number): string | undefined => {
  if (text === undefined) return undefined;
  const value = truncate(stripMassMentions(text).trim(), max);
  return value === '' ? undefined : value;
};

function safeUrl(raw: string | undefined): string | undefined {
  if (!raw || raw.length > 2048 || /\s/.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function isoOrUndefined(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function normalizeEmbed(loose: LooseEmbed): Embed | null {
  const title = clean(loose.title, EMBED_LIMITS.title);
  const description = clean(loose.description, EMBED_LIMITS.description);
  const fields: NonNullable<Embed['fields']> = [];
  for (const field of loose.fields ?? []) {
    const name = clean(field.name, EMBED_LIMITS.fieldName);
    if (!name || fields.length >= EMBED_LIMITS.fields) continue;
    fields.push({
      name,
      value: truncate(stripMassMentions(field.value).trim(), EMBED_LIMITS.fieldValue),
      ...(field.inline !== undefined && { inline: field.inline }),
    });
  }
  const footer = clean(loose.footer, EMBED_LIMITS.footerText);
  const author = clean(loose.author, EMBED_LIMITS.authorName);
  const url = safeUrl(loose.url);
  const timestamp = isoOrUndefined(loose.timestamp);
  const color =
    loose.color !== undefined && Number.isInteger(loose.color)
      ? Math.min(0xffffff, Math.max(0, loose.color))
      : undefined;
  if (!title && !description && fields.length === 0 && !footer && !author) return null;
  return {
    ...(title && { title }),
    ...(description && { description }),
    ...(url && { url }),
    ...(color !== undefined && { color }),
    ...(timestamp && { timestamp }),
    ...(fields.length > 0 && { fields }),
    ...(footer && { footer: { text: footer } }),
    ...(author && { author: { name: author } }),
  };
}

const chars = (embed: Embed): number =>
  (embed.title?.length ?? 0) +
  (embed.description?.length ?? 0) +
  (embed.footer?.text.length ?? 0) +
  (embed.author?.name.length ?? 0) +
  (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);

/**
 * Clamps a message to the embed limits and strips mass mentions, so no preset or template can
 * produce something the normal webhook validation would reject. Null when nothing is left.
 */
export function normalizeMessage(loose: LooseMessage): WebhookMessage | null {
  const content = truncate(stripMassMentions(loose.content ?? '').trim(), MAX_WEBHOOK_CONTENT);
  const embeds = (loose.embeds ?? [])
    .slice(0, EMBED_LIMITS.embeds)
    .map(normalizeEmbed)
    .filter((embed): embed is Embed => embed !== null);

  let total = embeds.reduce((sum, embed) => sum + chars(embed), 0);
  for (let i = embeds.length - 1; i >= 0 && total > EMBED_LIMITS.totalChars; i--) {
    const embed = embeds[i] as Embed;
    while (embed.fields?.length && total > EMBED_LIMITS.totalChars) {
      const removed = embed.fields.pop();
      total -= (removed?.name.length ?? 0) + (removed?.value.length ?? 0);
    }
    if (embed.fields?.length === 0) delete embed.fields;
    if (total > EMBED_LIMITS.totalChars && embed.description) {
      const keep = Math.max(1, embed.description.length - (total - EMBED_LIMITS.totalChars));
      embed.description = truncate(embed.description, keep);
      total = embeds.reduce((sum, e) => sum + chars(e), 0);
    }
  }

  if (content === '' && embeds.length === 0) return null;
  const username = clean(loose.username, 80);
  return { content, embeds, ...(username && { username }) };
}
