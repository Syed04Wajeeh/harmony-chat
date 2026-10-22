import { describe, expect, it } from 'vitest';
import { contrastRatio, findPreset, parseColor, type ThemeTokens } from '@harmony/shared';
import {
  autoFixContrast,
  checkContrast,
  keepAlpha,
  toInputHex,
  withAccent,
} from './themeEditor.js';

const tokensOf = (id: string): ThemeTokens => findPreset(id)?.tokens ?? {};
const levels = (tokens: ThemeTokens) =>
  Object.fromEntries(checkContrast(tokens).map((r) => [r.check.id, r.level]));

describe('contrast checker', () => {
  it('passes the built-in themes', () => {
    for (const id of ['harmony-dark', 'harmony-paper', 'midnight', 'rose']) {
      expect(Object.values(levels(tokensOf(id)))).not.toContain('fail');
    }
  });

  it('reports AAA for the high contrast preset', () => {
    expect(new Set(Object.values(levels(tokensOf('high-contrast'))))).toEqual(new Set(['AAA']));
  });

  it('flags a bad combination', () => {
    const bad = {
      ...tokensOf('harmony-dark'),
      'color-text-muted': '#3a3a3a',
      'color-accent-contrast': '#5fb89a',
    };
    const result = levels(bad);
    expect(result['muted']).toBe('fail');
    expect(result['accent']).toBe('fail');
    expect(result['text']).not.toBe('fail');
  });

  it('measures translucent tints over the panel', () => {
    const tokens = {
      ...tokensOf('harmony-dark'),
      'color-mention-soft': '#ffffffcc',
      'color-mention-text': '#ffffff',
    };
    expect(levels(tokens)['mention']).toBe('fail');
  });

  it('skips checks whose tokens are missing', () => {
    expect(checkContrast({})).toEqual([]);
  });
});

describe('auto-fix', () => {
  it('brings every failing pair to AA and leaves passing ones alone', () => {
    const base = tokensOf('harmony-dark');
    const bad: ThemeTokens = {
      ...base,
      'color-text-muted': '#3a3a3a',
      'color-text-faint': '#2a2a2a',
      'color-accent-contrast': '#5fb89a',
      'color-mention-text': '#222222',
    };
    const fixed = autoFixContrast(bad);
    expect(Object.values(levels(fixed))).not.toContain('fail');
    expect(fixed['color-text']).toBe(base['color-text']);
    expect(fixed['color-bg-panel']).toBe(base['color-bg-panel']);
    expect(fixed['color-accent']).toBe(base['color-accent']);
  });

  it('works on light themes too', () => {
    const bad = {
      ...tokensOf('rose'),
      'color-text-muted': '#e0b0c0',
      'color-text-link': '#ffd0e0',
    };
    expect(Object.values(levels(autoFixContrast(bad)))).not.toContain('fail');
  });

  it('can aim for AAA', () => {
    const fixed = autoFixContrast(tokensOf('midnight'), 7);
    const text = parseColor(fixed['color-text-muted'] ?? '');
    const panel = parseColor(fixed['color-bg-panel'] ?? '');
    expect(contrastRatio(text!, panel!)).toBeGreaterThanOrEqual(7);
  });
});

describe('editing helpers', () => {
  it('re-derives the accent family and keeps it readable', () => {
    const next = withAccent(tokensOf('harmony-dark'), 'dark', '#e879a8');
    expect(next['color-accent']).toBe('#e879a8');
    expect(next['color-accent-text']).not.toBe(tokensOf('harmony-dark')['color-accent-text']);
    expect(levels(next)['accent']).not.toBe('fail');
    expect(levels(next)['accent-text']).not.toBe('fail');
  });

  it('keeps the alpha of translucent tokens when a color is picked', () => {
    expect(keepAlpha('#ffffff1f', '#336699')).toBe('#3366991f');
    expect(keepAlpha('#ffffff', '#336699')).toBe('#336699');
    expect(toInputHex('#336699cc')).toBe('#336699');
    expect(toInputHex(undefined)).toBe('#000000');
  });
});
