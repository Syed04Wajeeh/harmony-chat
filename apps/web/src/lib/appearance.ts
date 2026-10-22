import { safeStorage } from './storage.js';

export type ThemeChoice = 'system' | 'dark' | 'light';
export type Density = 'compact' | 'cozy' | 'comfortable';
export type PanelStyle = 'floating' | 'flat';

export interface Appearance {
  theme: ThemeChoice;
  density: Density;
  panels: PanelStyle;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system',
  density: 'cozy',
  panels: 'floating',
};

export const THEMES: readonly ThemeChoice[] = ['system', 'dark', 'light'];
export const DENSITIES: readonly Density[] = ['compact', 'cozy', 'comfortable'];
export const PANEL_STYLES: readonly PanelStyle[] = ['floating', 'flat'];

/** Interim storage; the customization phase moves this to the server per user. */
export const APPEARANCE_KEY = 'harmony.appearance';

/** Browser chrome colors that match the canvas token of each theme (a manifest cannot read CSS). */
const CHROME: Record<'dark' | 'light', string> = { dark: '#141413', light: '#f7f4ee' };

const pick = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.find((candidate) => candidate === value) ?? fallback;

/** Anything unreadable or out of range falls back to the default, one field at a time. */
export function parseAppearance(raw: string | null): Appearance {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed === 'object' && parsed !== null) data = parsed as Record<string, unknown>;
  } catch {
    // Corrupt value: use defaults.
  }
  return {
    theme: pick(THEMES, data['theme'], DEFAULT_APPEARANCE.theme),
    density: pick(DENSITIES, data['density'], DEFAULT_APPEARANCE.density),
    panels: pick(PANEL_STYLES, data['panels'], DEFAULT_APPEARANCE.panels),
  };
}

export const loadAppearance = (): Appearance => parseAppearance(safeStorage.get(APPEARANCE_KEY));

/**
 * Writes the appearance onto <html> as data attributes; the token layer does the rest.
 * `system` removes data-theme so prefers-color-scheme decides.
 */
export function applyAppearance(
  appearance: Appearance,
  root: HTMLElement = document.documentElement,
): void {
  if (appearance.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', appearance.theme);
  root.setAttribute('data-density', appearance.density);
  root.setAttribute('data-panels', appearance.panels);

  const doc = root.ownerDocument;
  doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.dataset['systemColor'] ??= meta.content;
    meta.content =
      appearance.theme === 'system' ? meta.dataset['systemColor'] : CHROME[appearance.theme];
  });
}

/** Persists and applies a change. */
export function saveAppearance(appearance: Appearance): void {
  safeStorage.set(APPEARANCE_KEY, JSON.stringify(appearance));
  applyAppearance(appearance);
}

export function initAppearance(): Appearance {
  const appearance = loadAppearance();
  applyAppearance(appearance);
  return appearance;
}
