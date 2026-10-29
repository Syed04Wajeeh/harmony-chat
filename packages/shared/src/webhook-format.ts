import { z } from 'zod';

/** Services with a built-in converter; the server holds the converters. */
export const WEBHOOK_PRESETS = [
  'forgejo',
  'github',
  'alertmanager',
  'grafana',
  'watchtower',
  'generic',
] as const;
export const WebhookPreset = z.enum(WEBHOOK_PRESETS);
export type WebhookPreset = z.infer<typeof WebhookPreset>;

/** `discord` is the original Discord-compatible body; `template` uses the webhook's template. */
export const WEBHOOK_FORMATS = ['discord', ...WEBHOOK_PRESETS, 'template'] as const;
export const WebhookFormat = z.enum(WEBHOOK_FORMATS);
export type WebhookFormat = z.infer<typeof WebhookFormat>;

/** Presets whose sender can sign the body with a shared secret. */
export const SIGNED_FORMATS: readonly WebhookFormat[] = ['github', 'forgejo'];
export const supportsSignature = (format: WebhookFormat): boolean =>
  SIGNED_FORMATS.includes(format);

export const MAX_WEBHOOK_SECRET = 200;

export const MAX_WEBHOOK_CONTENT = 2000;

/** Keeps `@everyone` and `@here` from ever becoming mass pings, now or when they exist. */
export function stripMassMentions(content: string): string {
  return content.replace(/@(everyone|here)\b/gi, '@​$1');
}
