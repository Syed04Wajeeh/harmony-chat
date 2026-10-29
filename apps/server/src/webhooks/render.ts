import {
  WebhookExecuteBody,
  normalizeMessage,
  renderTemplate,
  type WebhookFormat,
  type WebhookTemplate,
} from '@harmony/shared';
import { AppError } from '../errors.js';
import { PRESETS, type Headers } from './presets/index.js';

export interface WebhookConfig {
  format: WebhookFormat;
  template: WebhookTemplate | null;
}

export interface Rendered {
  content: string;
  embeds: WebhookExecuteBody['embeds'];
  username?: string | undefined;
  avatarUrl?: string | undefined;
}

/**
 * Turns an incoming body into what to post, or null when there is nothing to post. Pure: the
 * live endpoint and the preview endpoint share it, so a preview shows exactly what would be sent.
 */
export function renderWebhook(
  config: WebhookConfig,
  headers: Headers,
  body: unknown,
): Rendered | null {
  if (config.format === 'discord') {
    const parsed = WebhookExecuteBody.safeParse(body);
    if (!parsed.success) {
      throw new AppError(400, 'invalid_request', 'Provide content, text or embeds as JSON');
    }
    return parsed.data;
  }
  const loose =
    config.format === 'template'
      ? config.template
        ? renderTemplate(config.template, body)
        : null
      : PRESETS[config.format](headers, body);
  return loose ? normalizeMessage(loose) : null;
}
