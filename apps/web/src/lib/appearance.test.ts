import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APPEARANCE,
  findPreset,
  parseColor,
  contrastRatio,
  type Appearance,
  type CustomTheme,
} from '@harmony/shared';
import {
  APPEARANCE_CACHE_KEY,
  CUSTOM_CSS_ID,
  LEGACY_APPEARANCE_KEY,
  applyAppearance,
  clearLegacyAppearance,
  completeTokens,
  guildAccentTokens,
  initAppearance,
  isSafeMode,
  readLegacyAppearance,
  resolveTheme,
  cacheAppearance,
} from './appearance.js';

const root = () => document.documentElement;
const appearance = (patch: Partial<Appearance> = {}): Appearance => ({
  ...DEFAULT_APPEARANCE,
  ...patch,
});
const custom = (patch: Partial<CustomTheme> = {}): CustomTheme => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Mine',
  base: 'dark',
  tokens: { 'color-accent': '#ff00aa', 'color-bg-canvas': '#101010', 'radius-card': '4px' },
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  ...patch,
});

function reset() {
  for (const name of ['data-theme', 'data-density', 'data-panels', 'data-motion'])
    root().removeAttribute(name);
  root().removeAttribute('style');
  document.getElementById(CUSTOM_CSS_ID)?.remove();
  localStorage.clear();
}

describe('resolveTheme', () => {
  const env = { customThemes: [custom()], prefersDark: false };

  it('lets the mode steer the Harmony themes', () => {
    expect(resolveTheme(appearance({ mode: 'system' }), env)).toMatchObject({
      attribute: undefined,
      base: 'light',
    });
    expect(
      resolveTheme(appearance({ mode: 'system' }), { ...env, prefersDark: true }),
    ).toMatchObject({ base: 'dark' });
    expect(resolveTheme(appearance({ mode: 'dark' }), env)).toMatchObject({
      attribute: 'dark',
      tokens: {},
    });
    expect(
      resolveTheme(appearance({ mode: 'light', themeId: 'harmony-paper' }), env).theme.id,
    ).toBe('harmony-paper');
    expect(resolveTheme(appearance({ mode: 'light' }), env).theme.id).toBe('harmony-paper');
  });

  it('gives other presets and custom themes their own base and tokens', () => {
    const rose = resolveTheme(appearance({ themeId: 'rose', mode: 'dark' }), env);
    expect(rose).toMatchObject({ attribute: 'light', base: 'light', custom: false });
    expect(rose.tokens['color-accent']).toBe(findPreset('rose')?.tokens['color-accent']);
    const mine = resolveTheme(appearance({ themeId: custom().id }), env);
    expect(mine).toMatchObject({ attribute: 'dark', custom: true });
  });

  it('falls back to Harmony for an unknown theme and in safe mode', () => {
    expect(resolveTheme(appearance({ themeId: 'deleted' }), env).theme.id).toMatch(/^harmony/);
    expect(
      resolveTheme(appearance({ themeId: custom().id }), { ...env, safeMode: true }).custom,
    ).toBe(false);
  });
});

describe('applyAppearance', () => {
  beforeEach(reset);

  it('writes the switches', () => {
    applyAppearance(appearance({ mode: 'light', density: 'compact', panels: 'flat' }));
    expect(root().dataset['theme']).toBe('light');
    expect(root().dataset['density']).toBe('compact');
    expect(root().dataset['panels']).toBe('flat');
  });

  it('leaves the theme to the OS for "system"', () => {
    applyAppearance(appearance({ mode: 'dark' }));
    applyAppearance(appearance({ mode: 'system' }));
    expect(root().hasAttribute('data-theme')).toBe(false);
  });

  it('applies to a given element instead of <html>', () => {
    const el = document.createElement('div');
    applyAppearance(appearance({ density: 'comfortable' }), {}, el);
    expect(el.dataset['density']).toBe('comfortable');
    expect(root().hasAttribute('data-density')).toBe(false);
  });

  it('sets theme tokens inline and removes them when the theme changes', () => {
    applyAppearance(appearance({ themeId: custom().id }), { customThemes: [custom()] });
    expect(root().style.getPropertyValue('--color-accent')).toBe('#ff00aa');
    expect(root().style.getPropertyValue('--radius-card')).toBe('4px');
    applyAppearance(appearance({ mode: 'dark' }), { customThemes: [custom()] });
    expect(root().style.getPropertyValue('--color-accent')).toBe('');
    expect(root().style.getPropertyValue('--radius-card')).toBe('');
  });

  it('refuses token values the server would have refused', () => {
    const hostile = custom({
      tokens: {
        'color-accent': 'red;}body{display:none',
        'color-text': 'url(http://e)',
        'color-border': '#abcdef',
      },
    });
    applyAppearance(appearance({ themeId: hostile.id }), { customThemes: [hostile] });
    expect(root().style.getPropertyValue('--color-accent')).toBe('');
    expect(root().style.getPropertyValue('--color-text')).toBe('');
    expect(root().style.getPropertyValue('--color-border')).toBe('#abcdef');
  });

  it('scales type and picks the message font', () => {
    applyAppearance(appearance({ fontScale: 1.25, messageFont: 'inter' }));
    expect(root().style.fontSize).toBe('125%');
    expect(root().style.getPropertyValue('--font-message')).toContain('Inter Variable');
    applyAppearance(appearance());
    expect(root().style.fontSize).toBe('');
  });

  it('maps the reduced motion override', () => {
    applyAppearance(appearance({ reducedMotion: 'on' }));
    expect(root().dataset['motion']).toBe('reduce');
    applyAppearance(appearance({ reducedMotion: 'off' }));
    expect(root().dataset['motion']).toBe('full');
    applyAppearance(appearance({ reducedMotion: 'system' }));
    expect(root().hasAttribute('data-motion')).toBe(false);
  });

  describe('custom CSS', () => {
    const css = '[data-harmony="message"] { outline: 1px solid red }';
    const style = () => document.getElementById(CUSTOM_CSS_ID);

    it('is injected last in <head> only when enabled', () => {
      applyAppearance(appearance({ customCss: css }));
      expect(style()).toBeNull();
      applyAppearance(appearance({ customCss: css, customCssEnabled: true }));
      expect(style()?.textContent).toBe(css);
      expect(document.head.lastElementChild).toBe(style());
      applyAppearance(appearance({ customCss: css, customCssEnabled: false }));
      expect(style()).toBeNull();
    });

    it('is sanitized again on the client', () => {
      applyAppearance(
        appearance({
          customCssEnabled: true,
          customCss:
            '@import "https://evil.example/x.css"; a { background: u\\rl(http://evil.example) }',
        }),
      );
      expect(style()?.textContent).not.toMatch(/evil\.example|@import/);
    });

    it('is off in safe mode, along with custom themes', () => {
      const mine = custom();
      applyAppearance(appearance({ customCssEnabled: true, customCss: css, themeId: mine.id }), {
        customThemes: [mine],
        safeMode: true,
      });
      expect(style()).toBeNull();
      expect(root().style.getPropertyValue('--color-accent')).toBe('');
    });
  });

  describe('guild accent', () => {
    const accentOf = () => root().style.getPropertyValue('--color-accent');

    it('recolors the accent family for a preset when allowed', () => {
      applyAppearance(appearance({ mode: 'dark' }), { guildAccent: 0x3b9ec7 });
      expect(accentOf()).toMatch(/^#/);
      expect(root().style.getPropertyValue('--color-accent-soft')).toMatch(/^#/);
      applyAppearance(appearance({ mode: 'dark' }), { guildAccent: null });
      expect(accentOf()).toBe('');
    });

    it("is ignored when switched off, in safe mode, and for the user's own theme", () => {
      applyAppearance(appearance({ useGuildAccent: false }), { guildAccent: 0x3b9ec7 });
      expect(accentOf()).toBe('');
      applyAppearance(appearance(), { guildAccent: 0x3b9ec7, safeMode: true });
      expect(accentOf()).toBe('');
      const mine = custom();
      applyAppearance(appearance({ themeId: mine.id }), {
        customThemes: [mine],
        guildAccent: 0x3b9ec7,
      });
      expect(accentOf()).toBe('#ff00aa');
    });

    it('stays readable on both theme bases for any hue', () => {
      for (const id of ['harmony-dark', 'harmony-paper'] as const) {
        const preset = findPreset(id)!;
        for (const color of [
          0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0x808080,
        ]) {
          const tokens = guildAccentTokens(color, preset.base, completeTokens(preset))!;
          const panel = parseColor(preset.tokens['color-bg-panel'] ?? '')!;
          expect(
            contrastRatio(parseColor(tokens['color-accent-text'] ?? '')!, panel),
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            contrastRatio(
              parseColor(tokens['color-accent-contrast'] ?? '')!,
              parseColor(tokens['color-accent'] ?? '')!,
            ),
          ).toBeGreaterThanOrEqual(3);
        }
      }
    });
  });
});

describe('persistence helpers', () => {
  beforeEach(reset);

  it('reads only the valid parts of the legacy local value', () => {
    expect(readLegacyAppearance()).toBeNull();
    localStorage.setItem(
      LEGACY_APPEARANCE_KEY,
      JSON.stringify({ theme: 'light', density: 'tiny', panels: 'flat' }),
    );
    expect(readLegacyAppearance()).toEqual({ mode: 'light', panels: 'flat' });
    localStorage.setItem(LEGACY_APPEARANCE_KEY, '{nope');
    expect(readLegacyAppearance()).toEqual({});
    clearLegacyAppearance();
    expect(localStorage.getItem(LEGACY_APPEARANCE_KEY)).toBeNull();
  });

  it('paints the first frame from the cache, or from the legacy value', () => {
    initAppearance(false);
    expect(root().dataset['density']).toBe('cozy');
    localStorage.setItem(LEGACY_APPEARANCE_KEY, JSON.stringify({ density: 'compact' }));
    initAppearance(false);
    expect(root().dataset['density']).toBe('compact');
    cacheAppearance(appearance({ density: 'comfortable', themeId: custom().id }), [custom()]);
    initAppearance(false);
    expect(root().dataset['density']).toBe('comfortable');
    expect(root().style.getPropertyValue('--color-accent')).toBe('#ff00aa');
    expect(localStorage.getItem(APPEARANCE_CACHE_KEY)).toContain('comfortable');
  });

  it('caches only the selected custom theme', () => {
    const other = custom({ id: '22222222-2222-4222-8222-222222222222' });
    cacheAppearance(appearance({ themeId: other.id }), [custom(), other]);
    const cached = JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? '{}') as {
      customThemes: CustomTheme[];
    };
    expect(cached.customThemes.map((t) => t.id)).toEqual([other.id]);
  });

  it('detects safe mode from the query string', () => {
    expect(isSafeMode('?safe')).toBe(true);
    expect(isSafeMode('?a=1&safe=1')).toBe(true);
    expect(isSafeMode('?unsafe')).toBe(false);
    expect(isSafeMode('')).toBe(false);
  });
});
