import { describe, expect, it } from 'vitest';
import {
  MAX_THEME_SHARE_LENGTH,
  ThemeInput,
  exportTheme,
  importTheme,
  isValidTokenValue,
  parseColor,
} from '@harmony/shared';

const theme = (tokens: Record<string, string>) =>
  ThemeInput.safeParse({ name: 'Test', base: 'dark', tokens });

describe('theme token validation', () => {
  it.each([
    '#fff',
    '#FFFF',
    '#1c1b19',
    '#1c1b19cc',
    'rgb(10, 20, 30)',
    'rgb(10 20 30)',
    'rgba(10, 20, 30, 0.5)',
    'rgb(10 20 30 / 50%)',
    'hsl(120, 40%, 50%)',
    'hsl(120deg 40% 50% / 0.4)',
    'hsla(120, 40%, 50%, .4)',
  ])('accepts the color %s', (value) => {
    expect(theme({ 'color-text': value }).success).toBe(true);
  });

  it.each([
    'red;}body{display:none',
    'red',
    'url(http://evil.example/x)',
    'url(data:image/png;base64,AAAA)',
    'var(--color-text)',
    'expression(alert(1))',
    '#fff;',
    '#fff}',
    '#ffff/*x*/',
    '#12345',
    '#gggggg',
    'rgb(300, 0, 0)',
    'rgb(0, 0, 0) !important',
    'rgb(0,0,0);color:red',
    'hsl(120, 140%, 50%)',
    'rgb(1 2 3 / 2)',
    'calc(1px)',
    'color-mix(in srgb, red 50%, blue)',
    '',
    `#${'f'.repeat(60)}`,
  ])('rejects the color %j', (value) => {
    expect(theme({ 'color-text': value }).success).toBe(false);
  });

  it('accepts bounded lengths on length tokens only', () => {
    expect(theme({ 'radius-card': '12px' }).success).toBe(true);
    expect(theme({ 'avatar-shape': '50%' }).success).toBe(true);
    expect(theme({ 'radius-card': '25px' }).success).toBe(false);
    expect(theme({ 'radius-card': '12%' }).success).toBe(false);
    expect(theme({ 'radius-card': '-1px' }).success).toBe(false);
    expect(theme({ 'radius-card': '12px;color:red' }).success).toBe(false);
    expect(theme({ 'radius-card': 'calc(10px + 1px)' }).success).toBe(false);
    expect(theme({ 'color-text': '12px' }).success).toBe(false);
    expect(isValidTokenValue('radius-panel', '0px')).toBe(true);
  });

  it('rejects tokens outside the allowlist', () => {
    expect(theme({ 'font-ui': 'serif' }).success).toBe(false);
    expect(theme({ 'color-text; background': '#fff' }).success).toBe(false);
    expect(theme({ 'space-1': '4px' }).success).toBe(false);
    expect(theme({ '--color-text': '#fff' }).success).toBe(false);
  });

  it('rejects oversize names and bad bases', () => {
    expect(ThemeInput.safeParse({ name: 'x'.repeat(41), base: 'dark', tokens: {} }).success).toBe(
      false,
    );
    expect(ThemeInput.safeParse({ name: ' ', base: 'dark', tokens: {} }).success).toBe(false);
    expect(ThemeInput.safeParse({ name: 'x', base: 'sepia', tokens: {} }).success).toBe(false);
  });

  it('parseColor does not accept trailing junk', () => {
    expect(parseColor('#fff\n')).not.toBeNull();
    expect(parseColor('#fff\nbody{}')).toBeNull();
  });
});

describe('theme sharing', () => {
  const input = {
    name: 'Dusk',
    base: 'dark' as const,
    tokens: { 'color-accent': '#8fb4ff', 'radius-card': '8px' },
  };

  it('round-trips through the export string', () => {
    const result = importTheme(exportTheme(input));
    expect(result).toEqual({ ok: true, theme: input });
  });

  it('applies the same validation on import', () => {
    const bad = JSON.stringify({
      v: 1,
      name: 'x',
      base: 'dark',
      tokens: { 'color-text': 'url(http://e)' },
    });
    expect(importTheme(bad).ok).toBe(false);
  });

  it.each([
    'not json',
    '[]',
    'null',
    JSON.stringify({ v: 2, name: 'x', base: 'dark', tokens: {} }),
    JSON.stringify({ v: 1, name: 'x', base: 'dark', tokens: {}, extra: true }),
    'x'.repeat(MAX_THEME_SHARE_LENGTH + 1),
  ])('refuses malformed input %#', (text) => {
    expect(importTheme(text).ok).toBe(false);
  });
});
