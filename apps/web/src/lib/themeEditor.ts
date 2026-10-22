import {
  accentTokens,
  composite,
  contrastLevel,
  contrastRatio,
  ensureContrast,
  parseColor,
  toHex,
  type ColorToken,
  type ContrastLevel,
  type Rgba,
  type ThemeBase,
  type ThemeTokens,
} from '@harmony/shared';

type Token = keyof ThemeTokens;

export interface TokenField {
  token: Token;
  label: string;
  hint?: string;
}

export interface TokenGroup {
  id: string;
  title: string;
  fields: readonly TokenField[];
}

/** What the editor shows, in order. Tokens not listed (avatar tones, viewer chrome) follow the base theme. */
export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    id: 'backgrounds',
    title: 'Backgrounds',
    fields: [
      { token: 'color-bg-canvas', label: 'Canvas', hint: 'Behind the panels' },
      { token: 'color-bg-panel', label: 'Panel', hint: 'Sidebar, chat, dialogs' },
      { token: 'color-bg-raised', label: 'Raised', hint: 'Composer, cards, embeds' },
      { token: 'color-bg-overlay', label: 'Overlay', hint: 'Menus and popovers' },
      { token: 'color-bg-input', label: 'Input' },
      { token: 'color-bg-code', label: 'Code' },
      { token: 'color-bg-hover', label: 'Hover' },
      { token: 'color-bg-active', label: 'Pressed' },
    ],
  },
  {
    id: 'text',
    title: 'Text',
    fields: [
      { token: 'color-text', label: 'Primary' },
      { token: 'color-text-muted', label: 'Muted' },
      { token: 'color-text-faint', label: 'Faint', hint: 'Timestamps and hints' },
      { token: 'color-text-link', label: 'Links' },
    ],
  },
  {
    id: 'accent',
    title: 'Accent',
    fields: [
      { token: 'color-accent', label: 'Accent', hint: 'Buttons and active items' },
      { token: 'color-accent-hover', label: 'Hover' },
      { token: 'color-accent-soft', label: 'Soft tint' },
      { token: 'color-accent-text', label: 'As text' },
      { token: 'color-accent-contrast', label: 'On accent', hint: 'Text inside accent buttons' },
    ],
  },
  {
    id: 'mention',
    title: 'Mention and highlight',
    fields: [
      { token: 'color-mention', label: 'Mention' },
      { token: 'color-mention-soft', label: 'Message tint' },
      { token: 'color-mention-text', label: 'On tint' },
      { token: 'color-mention-contrast', label: 'On mention' },
      { token: 'color-unread', label: 'Unread dot' },
    ],
  },
  {
    id: 'borders',
    title: 'Borders',
    fields: [
      { token: 'color-border', label: 'Divider' },
      { token: 'color-border-strong', label: 'Controls' },
      { token: 'color-scrim', label: 'Dialog dimming' },
    ],
  },
  {
    id: 'status',
    title: 'Status',
    fields: [
      { token: 'color-status-online', label: 'Online' },
      { token: 'color-status-idle', label: 'Idle' },
      { token: 'color-status-dnd', label: 'Do not disturb' },
      { token: 'color-status-offline', label: 'Offline' },
      { token: 'color-danger', label: 'Danger' },
      { token: 'color-danger-text', label: 'Danger text' },
      { token: 'color-danger-contrast', label: 'On danger' },
      { token: 'color-info', label: 'Info' },
    ],
  },
];

export const RADIUS_FIELDS = [
  { token: 'radius-panel', label: 'Panels', max: 32 },
  { token: 'radius-card', label: 'Cards', max: 24 },
  { token: 'radius-control', label: 'Buttons and inputs', max: 20 },
] as const;

/** One-tap accent colors for the quick picker. */
export const ACCENT_SWATCHES: readonly string[] = [
  '#5fb89a',
  '#6e9bff',
  '#a78bfa',
  '#e879a8',
  '#f08a4b',
  '#e6c340',
  '#7bc47f',
  '#2aa198',
  '#ef6f6f',
  '#8b949e',
];

export interface ContrastCheck {
  id: string;
  label: string;
  foreground: Token;
  /** The surfaces the text sits on; a translucent one is painted over the first panel. */
  backgrounds: readonly Token[];
  /** Large text and UI parts only need 3:1 for AA. */
  large?: boolean;
}

export const CONTRAST_CHECKS: readonly ContrastCheck[] = [
  {
    id: 'text',
    label: 'Text on panels',
    foreground: 'color-text',
    backgrounds: ['color-bg-panel', 'color-bg-raised'],
  },
  {
    id: 'muted',
    label: 'Muted text on panels',
    foreground: 'color-text-muted',
    backgrounds: ['color-bg-panel', 'color-bg-raised'],
  },
  {
    id: 'faint',
    label: 'Faint text on panels',
    foreground: 'color-text-faint',
    backgrounds: ['color-bg-panel', 'color-bg-code'],
  },
  {
    id: 'link',
    label: 'Links on panels',
    foreground: 'color-text-link',
    backgrounds: ['color-bg-panel'],
  },
  {
    id: 'accent',
    label: 'Text on accent buttons',
    foreground: 'color-accent-contrast',
    backgrounds: ['color-accent'],
  },
  {
    id: 'accent-text',
    label: 'Accent as text',
    foreground: 'color-accent-text',
    backgrounds: ['color-bg-panel'],
  },
  {
    id: 'mention',
    label: 'Mention text on its tint',
    foreground: 'color-mention-text',
    backgrounds: ['color-mention-soft'],
  },
  {
    id: 'mention-fill',
    label: 'Text on mention badges',
    foreground: 'color-mention-contrast',
    backgrounds: ['color-mention'],
  },
  {
    id: 'danger',
    label: 'Danger text on panels',
    foreground: 'color-danger-text',
    backgrounds: ['color-bg-panel'],
  },
];

export interface ContrastResult {
  check: ContrastCheck;
  /** The worst ratio across the check's surfaces. */
  ratio: number;
  level: ContrastLevel;
}

const color = (tokens: ThemeTokens, token: Token): Rgba | null => parseColor(tokens[token] ?? '');

/** Surfaces as opaque colors: a tint is composited over the panel it sits on. */
function surfaces(tokens: ThemeTokens, check: ContrastCheck): Rgba[] {
  const panel = color(tokens, 'color-bg-panel') ?? { r: 0, g: 0, b: 0, a: 1 };
  return check.backgrounds.flatMap((token) => {
    const value = color(tokens, token);
    return value ? [value.a < 1 ? composite(value, panel) : value] : [];
  });
}

export function checkContrast(tokens: ThemeTokens): ContrastResult[] {
  return CONTRAST_CHECKS.flatMap((check) => {
    const foreground = color(tokens, check.foreground);
    const backgrounds = surfaces(tokens, check);
    if (!foreground || backgrounds.length === 0) return [];
    const ratio = Math.min(...backgrounds.map((bg) => contrastRatio(foreground, bg)));
    return [{ check, ratio, level: contrastLevel(ratio, check.large) }];
  });
}

/** Nudges the lightness of each failing foreground until it reaches AA; backgrounds stay as chosen. */
export function autoFixContrast(tokens: ThemeTokens, target = 4.5): ThemeTokens {
  const fixed: ThemeTokens = { ...tokens };
  for (const check of CONTRAST_CHECKS) {
    const foreground = color(fixed, check.foreground);
    const backgrounds = surfaces(fixed, check);
    if (!foreground || backgrounds.length === 0) continue;
    fixed[check.foreground] = toHex(ensureContrast(foreground, backgrounds, target));
  }
  return fixed;
}

/** Applies a new accent and re-derives the colors that depend on it. */
export function withAccent(tokens: ThemeTokens, base: ThemeBase, hex: string): ThemeTokens {
  const accent = parseColor(hex);
  const panel = color(tokens, 'color-bg-panel');
  const raised = color(tokens, 'color-bg-raised');
  if (!accent || !panel || !raised) return tokens;
  return { ...tokens, ...accentTokens(accent, base, [panel, raised]) } satisfies Partial<
    Record<ColorToken, string>
  >;
}

/** `#rrggbb` for a native color input (which cannot hold an alpha channel). */
export const toInputHex = (value: string | undefined): string => {
  const parsed = parseColor(value ?? '');
  return parsed ? toHex({ ...parsed, a: 1 }) : '#000000';
};

/** A color input's value with the alpha of the token it replaces. */
export function keepAlpha(previous: string | undefined, picked: string): string {
  const alpha = parseColor(previous ?? '')?.a ?? 1;
  const next = parseColor(picked);
  return next ? toHex({ ...next, a: alpha }) : picked;
}
