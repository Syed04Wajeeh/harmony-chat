import { z } from 'zod';

/** Discord's embed limits; webhooks and bots share them. */
export const EMBED_LIMITS = {
  embeds: 10,
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  authorName: 256,
  /** Sum of title, description, field names and values, footer text and author name. */
  totalChars: 6000,
} as const;

const HttpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => !/\s/.test(value));

/** Uptime Kuma sends heartbeat times as `YYYY-MM-DD HH:mm:ss.SSS` in UTC, not ISO 8601. */
const KUMA_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

const LenientTimestamp = z.string().transform((value, ctx) => {
  const match = KUMA_TIME.exec(value);
  const ms = Date.parse(match ? `${match[1]}T${match[2]}Z` : value);
  if (Number.isNaN(ms)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid timestamp' });
    return z.NEVER;
  }
  return new Date(ms).toISOString();
});

export const EmbedField = z.object({
  name: z.string().min(1).max(EMBED_LIMITS.fieldName),
  // Discord rejects empty values; senders such as Uptime Kuma can produce them, so we accept.
  value: z.string().max(EMBED_LIMITS.fieldValue),
  inline: z.boolean().optional(),
});

const embedShape = <T extends z.ZodType<string>>(timestamp: T) => ({
  title: z.string().max(EMBED_LIMITS.title).optional(),
  description: z.string().max(EMBED_LIMITS.description).optional(),
  url: HttpUrl.optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  timestamp: timestamp.optional(),
  fields: z.array(EmbedField).max(EMBED_LIMITS.fields).optional(),
  footer: z
    .object({ text: z.string().min(1).max(EMBED_LIMITS.footerText), icon_url: HttpUrl.optional() })
    .optional(),
  author: z
    .object({
      name: z.string().min(1).max(EMBED_LIMITS.authorName),
      url: HttpUrl.optional(),
      icon_url: HttpUrl.optional(),
    })
    .optional(),
  thumbnail: z.object({ url: HttpUrl }).optional(),
  image: z.object({ url: HttpUrl }).optional(),
});

/** The stored and served shape: timestamps are already normalized to ISO 8601. */
export const Embed = z.object({
  ...embedShape(z.iso.datetime({ offset: true })),
  /**
   * Marks an invite card: the client renders the guild behind `code` with a Join button. Only the
   * server sets it (when a member sends invites), so it is not part of `EmbedInput`.
   */
  invite: z.object({ code: z.string().min(1).max(64) }).optional(),
});
export type Embed = z.infer<typeof Embed>;

/** What senders may submit; accepts Uptime Kuma's timestamp format and normalizes it. */
export const EmbedInput = z.object(embedShape(LenientTimestamp));

export function embedChars(embed: Embed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.author?.name.length ?? 0) +
    (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}

const withinBudget = (embeds: Embed[]) =>
  embeds.reduce((sum, e) => sum + embedChars(e), 0) <= EMBED_LIMITS.totalChars;
const budgetMessage = { message: `Embeds exceed ${EMBED_LIMITS.totalChars} characters in total` };

/** Embeds as served to clients. */
export const Embeds = z.array(Embed).max(EMBED_LIMITS.embeds).refine(withinBudget, budgetMessage);

/** Embeds as submitted by webhooks and bots. */
export const EmbedsInput = z
  .array(EmbedInput)
  .max(EMBED_LIMITS.embeds)
  .refine(withinBudget, budgetMessage);
