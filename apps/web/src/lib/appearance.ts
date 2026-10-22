import {
  DEFAULT_APPEARANCE,
  SEMANTIC_TOKENS,
  accentTokens,
  findPreset,
  isValidTokenValue,
  parseColor,
  sanitizeCss,
  type Appearance,
  type CustomTheme,
  type PresetTheme,
  type SemanticToken,
  type ThemeBase,
  type ThemeTokens,
} from '@harmony/shared';
import { readableColor } from './roleColor.js';
import { safeStorage } from './storage.js';

export { DEFAULT_APPEARANCE };

/** The old per-browser store, read once to migrate it to the server and then deleted. */
export const LEGACY_APPEARANCE_KEY = 'harmony.appearance';
/** The last applied appearance, kept only so the first paint matches; the server is the source. */
export const APPEARANCE_CACHE_KEY = 'harmony.appearance.cache';
export const CUSTOM_CSS_ID = 'user-custom-css';

export const MESSAGE_FONT_STACKS: Record<
  Appearance['messageFont'],
  { label: string; stack: string }
> = {
  manrope: { label: 'Manrope', stack: 'var(--font-ui)' },
  inter: { label: 'Inter', stack: "'Inter Variable', Inter, var(--font-ui)" },
  atkinson: {
    label: 'Atkinson Hyperlegible',
    stack: "'Atkinson Hyperlegible Next Variable', 'Atkinson Hyperlegible', var(--font-ui)",
  },
  plex: {
    label: 'IBM Plex Sans',
    stack: "'IBM Plex Sans Variable', 'IBM Plex Sans', var(--font-ui)",
  },
};

/** Browser chrome colors for the two stylesheet themes (a manifest cannot read CSS). */
const CHROME: Record<ThemeBase, string> = { dark: '#141413', light: '#f7f4ee' };

export type Theme = PresetTheme | (CustomTheme & { builtin?: undefined });

export interface ThemeEnv {
  customThemes: readonly CustomTheme[];
  prefersDark: boolean;
  safeMode?: boolean;
}

export interface ResolvedTheme {
  theme: Theme;
  /** What `data-theme` should say; undefined hands the choice to prefers-color-scheme. */
  attribute: ThemeBase | undefined;
  /** The base the theme renders as, whatever the attribute says. */
  base: ThemeBase;
  /** Tokens to set inline; empty for the stylesheet's own themes. */
  tokens: ThemeTokens;
  custom: boolean;
}

const harmony = (base: ThemeBase): PresetTheme => {
  const preset = findPreset(base === 'dark' ? 'harmony-dark' : 'harmony-paper');
  if (!preset) throw new Error('Harmony presets are missing');
  return preset;
};

export function findTheme(id: string, customThemes: readonly CustomTheme[]): Theme | undefined {
  return findPreset(id) ?? customThemes.find((theme) => theme.id === id);
}

/**
 * The look for these settings. `mode` steers only the two Harmony themes (including "system");
 * every other theme brings its own base.
 */
export function resolveTheme(appearance: Appearance, env: ThemeEnv): ResolvedTheme {
  const chosen = env.safeMode ? undefined : findTheme(appearance.themeId, env.customThemes);
  const theme = chosen ?? harmony('dark');
  if (theme.builtin) {
    const base: ThemeBase =
      appearance.mode === 'system' ? (env.prefersDark ? 'dark' : 'light') : appearance.mode;
    return {
      theme: harmony(base),
      attribute: appearance.mode === 'system' ? undefined : base,
      base,
      tokens: {},
      custom: false,
    };
  }
  return {
    theme,
    attribute: theme.base,
    base: theme.base,
    tokens: theme.tokens,
    custom: !findPreset(theme.id),
  };
}

/** A theme's tokens on top of its base's, so a partial or imported theme still renders completely. */
export const completeTokens = (theme: { base: ThemeBase; tokens: ThemeTokens }): ThemeTokens => ({
  ...harmony(theme.base).tokens,
  ...theme.tokens,
});

/** The guild accent family adjusted for a theme base, or null when it should not apply. */
export function guildAccentTokens(
  color: number,
  base: ThemeBase,
  surfaces: ThemeTokens,
): ThemeTokens | null {
  const accent = parseColor(readableColor(color, base));
  const panel = parseColor(surfaces['color-bg-panel'] ?? '');
  const raised = parseColor(surfaces['color-bg-raised'] ?? '');
  if (!accent || !panel || !raised) return null;
  return accentTokens(accent, base, [panel, raised]);
}

export interface ApplyOptions {
  customThemes?: readonly CustomTheme[];
  prefersDark?: boolean;
  safeMode?: boolean;
  /** The open guild's accent, applied when the user allows it and the theme is not their own. */
  guildAccent?: number | null;
}

const applied = new WeakMap<HTMLElement, Set<string>>();
const isToken = (name: string): name is SemanticToken =>
  (SEMANTIC_TOKENS as readonly string[]).includes(name);

function setTokens(root: HTMLElement, tokens: ThemeTokens): void {
  const previous = applied.get(root) ?? new Set<string>();
  const next = new Set<string>();
  for (const [name, value] of Object.entries(tokens)) {
    if (!isToken(name) || !isValidTokenValue(name, value)) continue;
    root.style.setProperty(`--${name}`, value);
    next.add(name);
  }
  for (const name of previous) if (!next.has(name)) root.style.removeProperty(`--${name}`);
  applied.set(root, next);
}

/** Injects (or removes) the user's stylesheet as the last element of <head>. */
export function applyCustomCss(css: string | null, doc: Document = document): void {
  let style = doc.getElementById(CUSTOM_CSS_ID);
  if (!css) {
    style?.remove();
    return;
  }
  style ??= Object.assign(doc.createElement('style'), { id: CUSTOM_CSS_ID });
  const clean = sanitizeCss(css).css;
  if (style.textContent !== clean) style.textContent = clean;
  doc.head.append(style);
}

/**
 * Writes the appearance onto <html>: data attributes for the switches, inline custom properties
 * for the theme, a font scale and the custom stylesheet. The token layer does the rest.
 */
export function applyAppearance(
  appearance: Appearance,
  options: ApplyOptions = {},
  root: HTMLElement = document.documentElement,
): ResolvedTheme {
  const { customThemes = [], safeMode = false, guildAccent = null } = options;
  const prefersDark =
    options.prefersDark ?? window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = resolveTheme(appearance, { customThemes, prefersDark, safeMode });

  if (resolved.attribute) root.setAttribute('data-theme', resolved.attribute);
  else root.removeAttribute('data-theme');
  root.setAttribute('data-density', appearance.density);
  root.setAttribute('data-panels', appearance.panels);
  if (appearance.reducedMotion === 'system') root.removeAttribute('data-motion');
  else root.setAttribute('data-motion', appearance.reducedMotion === 'on' ? 'reduce' : 'full');

  root.style.fontSize = appearance.fontScale === 1 ? '' : `${String(appearance.fontScale * 100)}%`;
  root.style.setProperty('--font-message', MESSAGE_FONT_STACKS[appearance.messageFont].stack);

  const accent =
    appearance.useGuildAccent && guildAccent !== null && !resolved.custom && !safeMode
      ? guildAccentTokens(guildAccent, resolved.base, completeTokens(resolved.theme))
      : null;
  setTokens(root, { ...resolved.tokens, ...accent });

  const customCss = appearance.customCssEnabled && !safeMode ? appearance.customCss : null;
  if (root === document.documentElement) applyCustomCss(customCss);

  const canvas = resolved.tokens['color-bg-canvas'];
  root.ownerDocument
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => {
      meta.dataset['systemColor'] ??= meta.content;
      meta.content =
        resolved.attribute === undefined
          ? meta.dataset['systemColor']
          : (canvas ?? CHROME[resolved.base]);
    });
  return resolved;
}

export interface CachedAppearance {
  appearance: Appearance;
  customThemes: CustomTheme[];
}

export function cacheAppearance(
  appearance: Appearance,
  customThemes: readonly CustomTheme[],
): void {
  const selected = customThemes.filter((theme) => theme.id === appearance.themeId);
  safeStorage.set(APPEARANCE_CACHE_KEY, JSON.stringify({ appearance, customThemes: selected }));
}

function readCache(): CachedAppearance | null {
  try {
    const parsed = JSON.parse(
      safeStorage.get(APPEARANCE_CACHE_KEY) ?? 'null',
    ) as CachedAppearance | null;
    return parsed && typeof parsed === 'object' && 'appearance' in parsed ? parsed : null;
  } catch {
    return null;
  }
}

/** Fields of the pre-server `harmony.appearance` value that still mean something. */
export function readLegacyAppearance(): Partial<Appearance> | null {
  const raw = safeStorage.get(LEGACY_APPEARANCE_KEY);
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const pick = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
      allowed.find((candidate) => candidate === value);
    return {
      ...(pick(['system', 'dark', 'light'], data['theme']) && {
        mode: pick(['system', 'dark', 'light'], data['theme']),
      }),
      ...(pick(['compact', 'cozy', 'comfortable'], data['density']) && {
        density: pick(['compact', 'cozy', 'comfortable'], data['density']),
      }),
      ...(pick(['floating', 'flat'], data['panels']) && {
        panels: pick(['floating', 'flat'], data['panels']),
      }),
    };
  } catch {
    return {};
  }
}

export const clearLegacyAppearance = (): void => safeStorage.remove(LEGACY_APPEARANCE_KEY);

/** `?safe` in the address disables custom CSS and custom themes for this page load. */
export const isSafeMode = (search: string = window.location.search): boolean =>
  new URLSearchParams(search).has('safe');

/** First paint, before React and the network: the cached appearance, or the old local choice. */
export function initAppearance(safeMode: boolean): void {
  const cached = readCache();
  const legacy = readLegacyAppearance();
  const appearance = { ...DEFAULT_APPEARANCE, ...legacy, ...cached?.appearance };
  applyAppearance(appearance, { customThemes: cached?.customThemes ?? [], safeMode });
}
