import { describe, expect, it } from 'vitest';
import {
  PRESET_THEMES,
  composite,
  contrastLevel,
  contrastRatio,
  ensureContrast,
  parseColor,
  toHex,
  type Rgba,
} from '@harmony/shared';

const c = (value: string): Rgba => {
  const parsed = parseColor(value);
  if (!parsed) throw new Error(value);
  return parsed;
};

describe('contrast math', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio(c('#000'), c('#fff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(c('#fff'), c('#fff'))).toBeCloseTo(1, 5);
    expect(contrastRatio(c('#767676'), c('#fff'))).toBeCloseTo(4.54, 2);
    expect(contrastRatio(c('#777777'), c('#ffffff'))).toBeCloseTo(4.48, 2);
  });

  it('is symmetric in which color is lighter', () => {
    expect(contrastRatio(c('#fff'), c('#123456'))).toBeCloseTo(
      contrastRatio(c('#123456'), c('#fff')),
      8,
    );
  });

  it('composites a translucent foreground over the background', () => {
    const half = c('#00000080');
    expect(contrastRatio(half, c('#fff'))).toBeCloseTo(
      contrastRatio(composite(half, c('#fff')), c('#fff')),
      8,
    );
    expect(contrastRatio(half, c('#fff'))).toBeLessThan(21);
  });

  it('labels levels', () => {
    expect(contrastLevel(7)).toBe('AAA');
    expect(contrastLevel(4.5)).toBe('AA');
    expect(contrastLevel(4.49)).toBe('fail');
    expect(contrastLevel(3, true)).toBe('AA');
    expect(contrastLevel(4.5, true)).toBe('AAA');
  });

  it('parses and formats colors', () => {
    expect(toHex(c('rgb(10 20 30)'))).toBe('#0a141e');
    expect(toHex(c('hsl(0 100% 50%)'))).toBe('#ff0000');
    expect(toHex(c('#abc'))).toBe('#aabbcc');
    expect(toHex(c('rgba(0, 0, 0, 0.5)'))).toBe('#00000080');
  });
});

describe('ensureContrast (auto-fix)', () => {
  it('leaves a passing color alone', () => {
    const fg = c('#ffffff');
    expect(ensureContrast(fg, [c('#101010')])).toBe(fg);
  });

  it.each([
    ['grey on dark', '#555555', '#222222'],
    ['grey on light', '#aaaaaa', '#ffffff'],
    ['pale accent on white', '#9be0c8', '#fffdf9'],
    ['dark accent on dark', '#1a3a30', '#141413'],
  ])('lifts %s to AA', (_name, fg, bg) => {
    const fixed = ensureContrast(c(fg), [c(bg)]);
    expect(contrastRatio(fixed, c(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('reaches AAA when asked and satisfies several backgrounds at once', () => {
    const backgrounds = [c('#111111'), c('#2a2a2a'), c('#333333')];
    const fixed = ensureContrast(c('#666666'), backgrounds, 7);
    for (const bg of backgrounds) expect(contrastRatio(fixed, bg)).toBeGreaterThanOrEqual(7);
  });

  it('keeps hue', () => {
    const fixed = ensureContrast(c('#335577'), [c('#101820')]);
    const [r, g, b] = [fixed.r, fixed.g, fixed.b];
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
  });
});

describe('built-in presets', () => {
  const PAIRS: [string, string, string, number][] = [
    ['text on panel', 'color-text', 'color-bg-panel', 1],
    ['text on raised', 'color-text', 'color-bg-raised', 1],
    ['muted on panel', 'color-text-muted', 'color-bg-panel', 1],
    ['muted on raised', 'color-text-muted', 'color-bg-raised', 1],
    ['faint on panel', 'color-text-faint', 'color-bg-panel', 1],
    ['faint on code', 'color-text-faint', 'color-bg-code', 1],
    ['link on panel', 'color-text-link', 'color-bg-panel', 1],
    ['accent text on panel', 'color-accent-text', 'color-bg-panel', 1],
    ['accent contrast on accent', 'color-accent-contrast', 'color-accent', 1],
    ['mention contrast on mention', 'color-mention-contrast', 'color-mention', 1],
    ['danger text on panel', 'color-danger-text', 'color-bg-panel', 1],
    ['danger contrast on danger', 'color-danger-contrast', 'color-danger', 1],
  ];

  it('has the expected set', () => {
    expect(PRESET_THEMES.map((preset) => preset.id)).toEqual([
      'harmony-dark',
      'harmony-paper',
      'midnight',
      'forest',
      'ember',
      'rose',
      'solarized',
      'high-contrast',
    ]);
  });

  describe.each(PRESET_THEMES)('$name', (preset) => {
    const get = (token: string) => c(preset.tokens[token as keyof typeof preset.tokens] ?? '');
    const need = preset.id === 'high-contrast' ? 7 : 4.5;

    it.each(PAIRS)('%s reaches the target', (_name, fg, bg) => {
      expect(contrastRatio(get(fg), get(bg))).toBeGreaterThanOrEqual(need);
    });

    it('mention text on its tint reaches the target', () => {
      const tint = composite(get('color-mention-soft'), get('color-bg-panel'));
      expect(contrastRatio(get('color-mention-text'), tint)).toBeGreaterThanOrEqual(need);
    });

    it('presence dots reach 3:1 on panels', () => {
      for (const token of ['online', 'idle', 'dnd', 'offline']) {
        expect(
          contrastRatio(get(`color-status-${token}`), get('color-bg-panel')),
        ).toBeGreaterThanOrEqual(3);
      }
    });
  });
});
