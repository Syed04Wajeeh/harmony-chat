import { truncate, type LooseEmbed } from '@harmony/shared';
import { COLORS, brief, isObj, obj, str, type Preset } from './util.js';

/**
 * Any JSON: well-known top-level keys become the title, text and link, the rest become fields.
 * Values are truncated, and nested objects are shown as compact JSON rather than walked.
 */

const TITLE_KEYS = ['title', 'subject', 'event', 'name', 'alert', 'monitor'];
const TEXT_KEYS = ['message', 'text', 'description', 'body', 'msg', 'summary', 'content'];
const URL_KEYS = ['url', 'link', 'html_url', 'permalink'];
const STATUS_KEYS = ['status', 'state', 'level', 'severity', 'result'];
const MAX_FIELDS = 10;
const MAX_VALUE = 200;

function statusColor(value: string | undefined): number {
  const v = value?.toLowerCase() ?? '';
  if (/\b(ok|success|succeeded|resolved|up|healthy|pass|passed|recovered|info)\b/.test(v))
    return COLORS.green;
  if (/\b(fail|failed|failure|error|critical|down|alerting|firing|fatal|crash)\b/.test(v))
    return COLORS.red;
  if (/\b(warn|warning|degraded|pending|unknown)\b/.test(v)) return COLORS.orange;
  return COLORS.blue;
}

const pick = (b: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = str(b[key]);
    if (value !== undefined) return key;
  }
  return undefined;
};

export const generic: Preset = (_headers, body) => {
  if (typeof body === 'string') {
    const text = body.trim();
    return text ? { content: truncate(text, 1500) } : null;
  }
  if (!isObj(body)) {
    if (Array.isArray(body) && body.length > 0) {
      return { content: `\`\`\`json\n${truncate(JSON.stringify(body, null, 2), 1500)}\n\`\`\`` };
    }
    return null;
  }
  const b = obj(body);
  if (Object.keys(b).length === 0) return null;

  const titleKey = pick(b, TITLE_KEYS);
  const textKey = pick(b, TEXT_KEYS);
  const urlKey = pick(b, URL_KEYS);
  const statusKey = pick(b, STATUS_KEYS);
  const used = new Set([titleKey, textKey, urlKey].filter((k): k is string => k !== undefined));

  const fields: NonNullable<LooseEmbed['fields']> = [];
  for (const [key, value] of Object.entries(b)) {
    if (used.has(key) || fields.length >= MAX_FIELDS) continue;
    const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : str(value);
    if (text === undefined) continue;
    fields.push({ name: key, value: truncate(text, MAX_VALUE), inline: text.length < 40 });
  }

  const title = titleKey ? str(b[titleKey]) : undefined;
  const description = textKey ? brief(str(b[textKey]), 1500) : undefined;
  if (!title && !description && fields.length === 0) return null;
  return {
    embeds: [
      {
        title: title ?? (description ? undefined : 'Webhook'),
        description,
        url: urlKey ? str(b[urlKey]) : undefined,
        color: statusColor(statusKey ? str(b[statusKey]) : undefined),
        fields,
      },
    ],
  };
};
