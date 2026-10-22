import {
  composite,
  contrastRatio,
  ensureContrast,
  fromHsl,
  mix,
  parseColor,
  toHex,
  toHsl,
  withAlpha,
  type Rgba,
} from './color.js';
import type { ColorToken, ThemeBase, ThemeTokens } from './theme.js';

const color = (value: string): Rgba => {
  const parsed = parseColor(value);
  if (!parsed) throw new Error(`Invalid color ${value}`);
  return parsed;
};

const WHITE = color('#ffffff');
const BLACK = color('#000000');

/** The colors a theme is built around; everything else is derived and can be overridden. */
export interface ThemeSeed {
  canvas: string;
  panel: string;
  raised: string;
  text: string;
  accent: string;
  mention: string;
  overlay?: string;
  danger?: string;
}

const shift = (value: Rgba, lightness: number): Rgba => {
  const [h, s, l] = toHsl(value);
  return { ...fromHsl(h, s, Math.min(1, Math.max(0, l + lightness))), a: value.a };
};

/** Whichever of white, black or the canvas reads best on `fill`. */
export function readableOn(fill: Rgba, canvas: Rgba = BLACK): Rgba {
  return [canvas, WHITE, BLACK].reduce((best, candidate) =>
    contrastRatio(candidate, fill) > contrastRatio(best, fill) ? candidate : best,
  );
}

/** The accent family for a new accent color on the given surfaces. */
export function accentTokens(
  accent: Rgba,
  base: ThemeBase,
  surfaces: readonly Rgba[],
  target = 4.5,
): Pick<
  Record<ColorToken, string>,
  | 'color-accent'
  | 'color-accent-hover'
  | 'color-accent-soft'
  | 'color-accent-text'
  | 'color-accent-contrast'
> {
  const soft = withAlpha(accent, base === 'dark' ? 0.16 : 0.13);
  const softOnPanel = surfaces[0] ? composite(soft, surfaces[0]) : soft;
  return {
    'color-accent': toHex(accent),
    'color-accent-hover': toHex(shift(accent, base === 'dark' ? 0.06 : -0.06)),
    'color-accent-soft': toHex(soft),
    'color-accent-text': toHex(ensureContrast(accent, [...surfaces, softOnPanel], target)),
    'color-accent-contrast': toHex(readableOn(accent)),
  };
}

const TONES = ['#4f6fa8', '#3b7a64', '#9a6128', '#a14860', '#ae4f3e', '#387a87', '#7759a3'];

/**
 * Builds a complete token map from a few seed colors. Text-bearing tokens are nudged until they
 * reach `target` (4.5 for AA, 7 for AAA) on every surface they sit on; `overrides` win.
 */
export function deriveTokens(
  base: ThemeBase,
  seed: ThemeSeed,
  overrides: Partial<Record<ColorToken, string>> = {},
  target = 4.5,
): Record<ColorToken, string> {
  const dark = base === 'dark';
  const canvas = color(seed.canvas);
  const panel = color(seed.panel);
  const raised = color(seed.raised);
  const overlay = color(seed.overlay ?? seed.raised);
  const text = color(seed.text);
  const accent = color(seed.accent);
  const mention = color(seed.mention);
  const input = canvas;
  const code = mix(input, accent, 0.07);
  const surfaces = [panel, raised, overlay, code, input];
  const contrast = target > 4.5 ? 0.6 : 1;

  const muted = ensureContrast(mix(text, panel, 0.28), surfaces, target);
  const faint = ensureContrast(mix(text, panel, 0.45), surfaces, target);
  const accentSet = accentTokens(accent, base, surfaces, target);
  const mentionSoft = withAlpha(mention, dark ? 0.11 : 0.2);
  const danger = color(seed.danger ?? (dark ? '#ef817a' : '#c23f37'));
  const dangerSoft = withAlpha(danger, dark ? 0.15 : 0.1);
  const status = (value: string) =>
    toHex(ensureContrast(color(value), [panel, raised], Math.max(3, target > 4.5 ? 4.5 : 3)));
  const tokens: Record<ColorToken, string> = {
    'color-bg-canvas': toHex(canvas),
    'color-bg-panel': toHex(panel),
    'color-bg-raised': toHex(raised),
    'color-bg-overlay': toHex(overlay),
    'color-bg-input': toHex(input),
    'color-bg-code': toHex(code),
    'color-bg-hover': toHex(withAlpha(text, dark ? 0.06 : 0.05)),
    'color-bg-active': toHex(withAlpha(text, dark ? 0.11 : 0.09)),
    'color-border': toHex(mix(panel, text, 0.12 * contrast)),
    'color-border-strong': toHex(mix(panel, text, 0.24 * contrast)),
    'color-scrim': toHex(withAlpha(dark ? canvas : color('#1c1b19'), dark ? 0.66 : 0.32)),
    'color-text': toHex(text),
    'color-text-muted': toHex(muted),
    'color-text-faint': toHex(faint),
    'color-text-link': toHex(ensureContrast(mix(accent, text, 0.2), surfaces, target)),
    ...accentSet,
    'color-mention': toHex(mention),
    'color-mention-soft': toHex(mentionSoft),
    'color-mention-text': toHex(
      ensureContrast(mention, [panel, raised, composite(mentionSoft, panel)], target),
    ),
    'color-mention-contrast': toHex(readableOn(mention)),
    'color-unread': toHex(ensureContrast(mention, [panel], 3)),
    'color-danger': toHex(danger),
    'color-danger-hover': toHex(shift(danger, dark ? 0.06 : -0.06)),
    'color-danger-soft': toHex(dangerSoft),
    'color-danger-text': toHex(
      ensureContrast(danger, [panel, raised, composite(dangerSoft, panel)], target),
    ),
    'color-danger-contrast': toHex(readableOn(danger)),
    'color-info': status(dark ? '#7fa8ec' : '#3f6fc0'),
    'color-status-online': status(dark ? '#86cf5f' : '#46902b'),
    'color-status-idle': status(dark ? '#e6c340' : '#a98515'),
    'color-status-dnd': status(toHex(danger)),
    'color-status-offline': status('#858074'),
    'color-tone-0': TONES[0] ?? '',
    'color-tone-1': TONES[1] ?? '',
    'color-tone-2': TONES[2] ?? '',
    'color-tone-3': TONES[3] ?? '',
    'color-tone-4': TONES[4] ?? '',
    'color-tone-5': TONES[5] ?? '',
    'color-tone-6': TONES[6] ?? '',
    'color-tone-contrast': '#ffffff',
    'color-switch-thumb': '#ffffff',
    'color-viewer-bg': '#141413eb',
    'color-viewer-text': '#efebe2',
    'color-viewer-control': '#efebe224',
  };
  return { ...tokens, ...overrides };
}

export interface PresetTheme {
  id: string;
  name: string;
  base: ThemeBase;
  /** Harmony's own themes are the stylesheet defaults and need no inline tokens. */
  builtin?: boolean;
  tokens: ThemeTokens;
}

const HARMONY_DARK = deriveTokens(
  'dark',
  {
    canvas: '#141413',
    panel: '#1c1b19',
    raised: '#232220',
    overlay: '#2a2925',
    text: '#efebe2',
    accent: '#5fb89a',
    mention: '#f2a65a',
  },
  {
    'color-bg-input': '#181816',
    'color-border': '#2a2925',
    'color-border-strong': '#403d36',
    'color-text-muted': '#bdb8aa',
    'color-text-faint': '#a09b8d',
    'color-text-link': '#94d5bb',
    'color-accent-hover': '#6cc4a1',
    'color-accent-text': '#94d5bb',
    'color-accent-contrast': '#141413',
    'color-mention-text': '#f7be85',
    'color-mention-contrast': '#141413',
    'color-unread': '#f2a65a',
    'color-danger-hover': '#f5a29a',
    'color-danger-text': '#f5a29a',
    'color-danger-contrast': '#141413',
    'color-status-offline': '#858074',
  },
);

const HARMONY_PAPER = deriveTokens(
  'light',
  {
    canvas: '#f7f4ee',
    panel: '#fffdf9',
    raised: '#ffffff',
    overlay: '#ffffff',
    text: '#1c1b19',
    accent: '#2c7a61',
    mention: '#f2a65a',
    danger: '#c23f37',
  },
  {
    'color-bg-input': '#f7f4ee',
    'color-border': '#e6e1d6',
    'color-border-strong': '#d9d4c7',
    'color-text-muted': '#5c584e',
    'color-text-faint': '#6a665b',
    'color-text-link': '#225f4c',
    'color-accent-hover': '#225f4c',
    'color-accent-text': '#225f4c',
    'color-accent-contrast': '#ffffff',
    'color-mention-text': '#66380e',
    'color-mention-contrast': '#141413',
    'color-unread': '#bf6f20',
    'color-danger-hover': '#9e2e28',
    'color-danger-text': '#9e2e28',
    'color-danger-contrast': '#ffffff',
    'color-status-offline': '#858074',
  },
);

export const PRESET_THEMES: readonly PresetTheme[] = [
  { id: 'harmony-dark', name: 'Harmony Dark', base: 'dark', builtin: true, tokens: HARMONY_DARK },
  {
    id: 'harmony-paper',
    name: 'Harmony Paper',
    base: 'light',
    builtin: true,
    tokens: HARMONY_PAPER,
  },
  {
    id: 'midnight',
    name: 'Midnight',
    base: 'dark',
    tokens: deriveTokens('dark', {
      canvas: '#0a0e17',
      panel: '#101624',
      raised: '#172033',
      overlay: '#1d2840',
      text: '#e6ecf7',
      accent: '#6e9bff',
      mention: '#f0b35e',
    }),
  },
  {
    id: 'forest',
    name: 'Forest',
    base: 'dark',
    tokens: deriveTokens('dark', {
      canvas: '#0d1511',
      panel: '#131d18',
      raised: '#1a2720',
      overlay: '#21322a',
      text: '#e4eee6',
      accent: '#7bc47f',
      mention: '#e8b45a',
    }),
  },
  {
    id: 'ember',
    name: 'Ember',
    base: 'dark',
    tokens: {
      ...deriveTokens('dark', {
        canvas: '#17110d',
        panel: '#1f1712',
        raised: '#2a1f18',
        overlay: '#34271e',
        text: '#f4e8dc',
        accent: '#f08a4b',
        mention: '#f2c14e',
      }),
      'radius-panel': '22px',
      'radius-card': '16px',
      'radius-control': '12px',
    },
  },
  {
    id: 'rose',
    name: 'Rosé',
    base: 'light',
    tokens: {
      ...deriveTokens('light', {
        canvas: '#fbeff1',
        panel: '#fff8f9',
        raised: '#ffffff',
        overlay: '#ffffff',
        text: '#3a2229',
        accent: '#b83a64',
        mention: '#f2a65a',
      }),
      'avatar-shape': '50%',
    },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    base: 'dark',
    tokens: deriveTokens('dark', {
      canvas: '#00212b',
      panel: '#002b36',
      raised: '#073642',
      overlay: '#0d4351',
      text: '#eee8d5',
      accent: '#2aa198',
      mention: '#e0763a',
    }),
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    base: 'dark',
    tokens: {
      ...deriveTokens(
        'dark',
        {
          canvas: '#000000',
          panel: '#0a0a0a',
          raised: '#141414',
          overlay: '#1c1c1c',
          text: '#ffffff',
          accent: '#ffd60a',
          mention: '#4de3ff',
        },
        {},
        7,
      ),
      'radius-panel': '8px',
      'radius-card': '6px',
      'radius-control': '6px',
    },
  },
];

export const findPreset = (id: string): PresetTheme | undefined =>
  PRESET_THEMES.find((preset) => preset.id === id);
