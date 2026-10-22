import { z } from 'zod';
import { parseColor } from './color.js';

/**
 * The semantic tokens a theme may set. Colors are every `--color-*` token in `tokens.css`; the
 * lengths are the corner radii. A test in the web package keeps this list equal to the stylesheet.
 */
export const COLOR_TOKENS = [
  'color-bg-canvas',
  'color-bg-panel',
  'color-bg-raised',
  'color-bg-overlay',
  'color-bg-input',
  'color-bg-code',
  'color-bg-hover',
  'color-bg-active',
  'color-border',
  'color-border-strong',
  'color-scrim',
  'color-text',
  'color-text-muted',
  'color-text-faint',
  'color-text-link',
  'color-accent',
  'color-accent-hover',
  'color-accent-soft',
  'color-accent-text',
  'color-accent-contrast',
  'color-mention',
  'color-mention-soft',
  'color-mention-text',
  'color-mention-contrast',
  'color-unread',
  'color-danger',
  'color-danger-hover',
  'color-danger-soft',
  'color-danger-text',
  'color-danger-contrast',
  'color-info',
  'color-status-online',
  'color-status-idle',
  'color-status-dnd',
  'color-status-offline',
  'color-tone-0',
  'color-tone-1',
  'color-tone-2',
  'color-tone-3',
  'color-tone-4',
  'color-tone-5',
  'color-tone-6',
  'color-tone-contrast',
  'color-switch-thumb',
  'color-viewer-bg',
  'color-viewer-text',
  'color-viewer-control',
] as const;

/** Length tokens and the range each may take. */
export const LENGTH_TOKENS = {
  'radius-panel': { max: 32, unit: 'px' },
  'radius-card': { max: 24, unit: 'px' },
  'radius-control': { max: 20, unit: 'px' },
  'radius-tile': { max: 24, unit: 'px' },
  'radius-inline': { max: 12, unit: 'px' },
  'radius-sheet': { max: 32, unit: 'px' },
  'avatar-shape': { max: 50, unit: '%' },
} as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type LengthToken = keyof typeof LENGTH_TOKENS;
export const SEMANTIC_TOKENS = [
  ...COLOR_TOKENS,
  ...(Object.keys(LENGTH_TOKENS) as LengthToken[]),
] as const;
export type SemanticToken = (typeof SEMANTIC_TOKENS)[number];

const isLengthToken = (token: string): token is LengthToken => token in LENGTH_TOKENS;

/** Whether `value` is acceptable for `token`: a plain color, or a bounded length. Nothing else. */
export function isValidTokenValue(token: SemanticToken, value: string): boolean {
  if (!isLengthToken(token)) return parseColor(value) !== null;
  const { max, unit } = LENGTH_TOKENS[token];
  const match = /^(\d{1,2}(?:\.\d{1,2})?)(px|%)$/.exec(value);
  return match !== null && match[2] === unit && Number.parseFloat(match[1] ?? '') <= max;
}

export const MAX_CUSTOM_THEMES = 20;
export const MAX_THEME_NAME_LENGTH = 40;

export const ThemeBase = z.enum(['dark', 'light']);
export type ThemeBase = z.infer<typeof ThemeBase>;

export const ThemeTokens = z
  .partialRecord(z.enum(SEMANTIC_TOKENS), z.string().max(48))
  .superRefine((tokens, ctx) => {
    for (const [token, value] of Object.entries(tokens)) {
      if (value !== undefined && !isValidTokenValue(token as SemanticToken, value)) {
        ctx.addIssue({ code: 'custom', path: [token], message: `Invalid value for ${token}` });
      }
    }
  });
export type ThemeTokens = z.infer<typeof ThemeTokens>;

export const ThemeName = z.string().trim().min(1).max(MAX_THEME_NAME_LENGTH);

export const ThemeInput = z.object({ name: ThemeName, base: ThemeBase, tokens: ThemeTokens });
export type ThemeInput = z.infer<typeof ThemeInput>;

export const CustomTheme = ThemeInput.extend({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CustomTheme = z.infer<typeof CustomTheme>;

export const ThemeParams = z.object({ id: z.uuid() });
export const ListThemesResponse = z.object({ themes: z.array(CustomTheme) });
export type ListThemesResponse = z.infer<typeof ListThemesResponse>;

/** The text users copy between instances: compact JSON, validated like any other theme input. */
export const ThemeShare = z.strictObject({ v: z.literal(1), ...ThemeInput.shape });
export const MAX_THEME_SHARE_LENGTH = 8 * 1024;

export function exportTheme(theme: ThemeInput): string {
  return JSON.stringify({ v: 1, name: theme.name, base: theme.base, tokens: theme.tokens });
}

export type ImportResult = { ok: true; theme: ThemeInput } | { ok: false; error: string };

export function importTheme(text: string): ImportResult {
  if (text.length > MAX_THEME_SHARE_LENGTH) return { ok: false, error: 'That text is too long' };
  let data: unknown;
  try {
    data = JSON.parse(text.trim());
  } catch {
    return { ok: false, error: 'That is not a theme string' };
  }
  const parsed = ThemeShare.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? 'That is not a valid theme' };
  }
  const { name, base, tokens } = parsed.data;
  return { ok: true, theme: { name, base, tokens } };
}
