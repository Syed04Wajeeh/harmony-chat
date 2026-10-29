import { z } from 'zod';
import { stripMassMentions } from './webhook-format.js';
import { truncate, type LooseEmbed, type LooseMessage } from './webhook-message.js';

/**
 * Declarative webhook templates. A template is data: strings with `{{path | filter}}`
 * placeholders resolved against the JSON body. There are no loops, conditions, expressions or
 * code; the filters are a fixed list.
 */

export const TEMPLATE_LIMITS = {
  /** One template string. */
  string: 2000,
  /** Placeholders in a whole template, which bounds the work per request. */
  placeholders: 100,
  /** Segments in one path. */
  pathDepth: 12,
  /** Longest single substituted value before filters, in characters. */
  value: 10_000,
  fields: 10,
} as const;

export const TEMPLATE_FILTERS = ['upper', 'lower', 'truncate', 'default', 'json'] as const;

type Segment = string | number;
type Filter =
  | { name: 'upper' | 'lower' | 'json' }
  | { name: 'truncate'; length: number }
  | { name: 'default'; value: string };

type Part = string | { path: Segment[]; filters: Filter[] };
export type CompiledString = Part[];

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

function parsePath(raw: string): Segment[] | string {
  const text = raw.trim();
  if (text === '' || text.length > 200) return 'empty or too long a path';
  const segments: Segment[] = [];
  // `a.b[0].c`, `a.0.b` and `[0]` at the start are all accepted.
  for (const piece of text.split('.')) {
    const match = /^([^[\]]*)((?:\[\d{1,6}\])*)$/.exec(piece);
    if (!match) return `bad path segment "${piece.slice(0, 30)}"`;
    const key = match[1] ?? '';
    if (key !== '') segments.push(/^\d{1,6}$/.test(key) ? Number(key) : key);
    else if (!match[2]) return 'empty path segment';
    for (const index of (match[2] ?? '').matchAll(/\[(\d+)\]/g)) segments.push(Number(index[1]));
  }
  if (segments.length > TEMPLATE_LIMITS.pathDepth) return 'path is too deep';
  for (const seg of segments) {
    if (typeof seg === 'string' && FORBIDDEN_KEYS.has(seg)) return `"${seg}" is not allowed`;
  }
  return segments;
}

/** Splits on `|` outside double quotes. */
function splitPipes(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === '|' && !quoted) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

function parseFilter(raw: string): Filter | string {
  const text = raw.trim();
  const colon = text.indexOf(':');
  const name = (colon === -1 ? text : text.slice(0, colon)).trim();
  const arg = colon === -1 ? undefined : text.slice(colon + 1).trim();
  switch (name) {
    case 'upper':
    case 'lower':
    case 'json':
      return arg === undefined ? { name } : `filter "${name}" takes no argument`;
    case 'truncate': {
      if (arg === undefined || !/^\d{1,4}$/.test(arg) || Number(arg) < 1) {
        return 'truncate needs a length, like truncate:80';
      }
      return { name, length: Math.min(Number(arg), TEMPLATE_LIMITS.string) };
    }
    case 'default': {
      if (arg === undefined) return 'default needs a value, like default:"n/a"';
      const quoted = /^"([^"]*)"$/.exec(arg);
      return { name, value: (quoted ? quoted[1] : arg) ?? '' };
    }
    default:
      return `unknown filter "${name.slice(0, 30)}"; use ${TEMPLATE_FILTERS.join(', ')}`;
  }
}

export type CompileResult = { ok: true; parts: CompiledString } | { ok: false; error: string };

export function compileTemplateString(source: string): CompileResult {
  const parts: Part[] = [];
  let last = 0;
  let count = 0;
  for (const match of source.matchAll(PLACEHOLDER)) {
    if (++count > TEMPLATE_LIMITS.placeholders)
      return { ok: false, error: 'too many placeholders' };
    if (match.index > last) parts.push(source.slice(last, match.index));
    const [pathText = '', ...filterTexts] = splitPipes(match[1] ?? '');
    const path = parsePath(pathText);
    if (typeof path === 'string') return { ok: false, error: path };
    const filters: Filter[] = [];
    for (const text of filterTexts) {
      const filter = parseFilter(text);
      if (typeof filter === 'string') return { ok: false, error: filter };
      filters.push(filter);
    }
    parts.push({ path, filters });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push(source.slice(last));
  // A leftover `{{` or `}}` is a typo that would otherwise print literally.
  if (parts.some((p) => typeof p === 'string' && /\{\{|\}\}/.test(p))) {
    return { ok: false, error: 'unbalanced {{ }}' };
  }
  return { ok: true, parts };
}

function resolve(body: unknown, path: Segment[]): unknown {
  let current = body;
  for (const seg of path) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (typeof seg !== 'number') return undefined;
      current = current[seg];
    } else {
      // Own properties only: nothing is ever read from a prototype.
      const key = String(seg);
      if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

function stringify(value: unknown, asJson: boolean): string {
  if (asJson) return truncate(JSON.stringify(value ?? null) ?? 'null', TEMPLATE_LIMITS.value);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return truncate(value, TEMPLATE_LIMITS.value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return truncate(JSON.stringify(value) ?? '', TEMPLATE_LIMITS.value);
}

function applyFilters(value: unknown, filters: Filter[]): string {
  let text = stringify(
    value,
    filters.some((f) => f.name === 'json'),
  );
  for (const filter of filters) {
    switch (filter.name) {
      case 'upper':
        text = text.toUpperCase();
        break;
      case 'lower':
        text = text.toLowerCase();
        break;
      case 'truncate':
        text = truncate(text, filter.length);
        break;
      case 'default':
        if (text === '') text = filter.value;
        break;
      case 'json':
        break;
    }
  }
  return text;
}

export function renderCompiled(parts: CompiledString, body: unknown): string {
  let out = '';
  for (const part of parts) {
    out += typeof part === 'string' ? part : applyFilters(resolve(body, part.path), part.filters);
    if (out.length > TEMPLATE_LIMITS.string * 4) break;
  }
  return stripMassMentions(out);
}

/** A string that must parse as a template string. */
const TemplateText = (max: number = TEMPLATE_LIMITS.string) =>
  z
    .string()
    .max(max)
    .superRefine((value, ctx) => {
      const result = compileTemplateString(value);
      if (!result.ok) ctx.addIssue({ code: 'custom', message: result.error });
    });

export const WebhookTemplate = z
  .object({
    content: TemplateText().optional(),
    embed: z
      .object({
        title: TemplateText(256).optional(),
        description: TemplateText(4096).optional(),
        url: TemplateText(2048).optional(),
        /** A number, or text that renders to `#rrggbb` or a decimal number. */
        color: z.union([z.number().int().min(0).max(0xffffff), TemplateText(64)]).optional(),
        fields: z
          .array(
            z.object({
              name: TemplateText(256),
              value: TemplateText(1024),
              inline: z.boolean().optional(),
            }),
          )
          .max(TEMPLATE_LIMITS.fields)
          .optional(),
        footer: TemplateText(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((template, ctx) => {
    if (template.content === undefined && template.embed === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Provide content or an embed' });
    }
    // Whole-template cap, so the work per request is bounded however it is written.
    const strings: string[] = [];
    if (template.content) strings.push(template.content);
    const embed = template.embed;
    if (embed) {
      for (const s of [embed.title, embed.description, embed.url, embed.footer]) {
        if (s) strings.push(s);
      }
      if (typeof embed.color === 'string') strings.push(embed.color);
      for (const f of embed.fields ?? []) strings.push(f.name, f.value);
    }
    const placeholders = strings.reduce((n, s) => n + (s.match(PLACEHOLDER)?.length ?? 0), 0);
    if (placeholders > TEMPLATE_LIMITS.placeholders) {
      ctx.addIssue({ code: 'custom', message: 'Too many placeholders in this template' });
    }
  });
export type WebhookTemplate = z.infer<typeof WebhookTemplate>;

function renderString(source: string | undefined, body: unknown): string | undefined {
  if (source === undefined) return undefined;
  const compiled = compileTemplateString(source);
  return compiled.ok ? renderCompiled(compiled.parts, body) : undefined;
}

function parseColor(text: string | undefined): number | undefined {
  const value = text?.trim();
  if (!value) return undefined;
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return parseInt(hex[1] as string, 16);
  if (/^\d{1,8}$/.test(value)) {
    const n = Number(value);
    return n <= 0xffffff ? n : undefined;
  }
  return undefined;
}

/**
 * Renders a validated template against a body. The result still goes through
 * `normalizeMessage`, which enforces the embed limits.
 */
export function renderTemplate(template: WebhookTemplate, body: unknown): LooseMessage {
  const spec = template.embed;
  let embeds: LooseEmbed[] | undefined;
  if (spec) {
    const color =
      typeof spec.color === 'number' ? spec.color : parseColor(renderString(spec.color, body));
    embeds = [
      {
        title: renderString(spec.title, body),
        description: renderString(spec.description, body),
        url: renderString(spec.url, body),
        color,
        footer: renderString(spec.footer, body),
        fields: (spec.fields ?? []).map((field) => ({
          name: renderString(field.name, body) ?? '',
          value: renderString(field.value, body) ?? '',
          ...(field.inline !== undefined && { inline: field.inline }),
        })),
      },
    ];
  }
  return { content: renderString(template.content, body) ?? '', embeds };
}
