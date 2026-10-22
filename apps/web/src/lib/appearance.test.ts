import { beforeEach, describe, expect, it } from 'vitest';
import {
  APPEARANCE_KEY,
  DEFAULT_APPEARANCE,
  applyAppearance,
  initAppearance,
  loadAppearance,
  parseAppearance,
  saveAppearance,
} from './appearance.js';

const root = () => document.documentElement;

describe('applyAppearance', () => {
  beforeEach(() => {
    for (const name of ['data-theme', 'data-density', 'data-panels']) root().removeAttribute(name);
    localStorage.clear();
  });

  it('writes density and panels, and sets an explicit theme', () => {
    applyAppearance({ theme: 'light', density: 'compact', panels: 'flat' });
    expect(root().dataset['theme']).toBe('light');
    expect(root().dataset['density']).toBe('compact');
    expect(root().dataset['panels']).toBe('flat');
  });

  it('leaves the theme to the OS for "system" by removing the attribute', () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, theme: 'dark' });
    expect(root().dataset['theme']).toBe('dark');
    applyAppearance({ ...DEFAULT_APPEARANCE, theme: 'system' });
    expect(root().hasAttribute('data-theme')).toBe(false);
  });

  it('applies to a given element instead of <html>', () => {
    const el = document.createElement('div');
    applyAppearance({ theme: 'dark', density: 'comfortable', panels: 'floating' }, el);
    expect(el.dataset['density']).toBe('comfortable');
    expect(root().hasAttribute('data-density')).toBe(false);
  });

  it('keeps the browser chrome color in step and restores the system value', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#111111';
    document.head.append(meta);
    applyAppearance({ ...DEFAULT_APPEARANCE, theme: 'light' });
    expect(meta.content).toBe('#f7f4ee');
    applyAppearance({ ...DEFAULT_APPEARANCE, theme: 'system' });
    expect(meta.content).toBe('#111111');
    meta.remove();
  });
});

describe('persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips through localStorage', () => {
    saveAppearance({ theme: 'dark', density: 'comfortable', panels: 'flat' });
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? '{}')).toEqual({
      theme: 'dark',
      density: 'comfortable',
      panels: 'flat',
    });
    expect(loadAppearance()).toEqual({ theme: 'dark', density: 'comfortable', panels: 'flat' });
  });

  it('falls back field by field on corrupt or unknown values', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('{not json')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('"string"')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('{"theme":"neon","density":"compact","panels":7}')).toEqual({
      theme: 'system',
      density: 'compact',
      panels: 'floating',
    });
  });

  it('initAppearance applies what was saved', () => {
    localStorage.setItem(
      APPEARANCE_KEY,
      JSON.stringify({ theme: 'light', density: 'compact', panels: 'flat' }),
    );
    initAppearance();
    expect(root().dataset['theme']).toBe('light');
    expect(root().dataset['panels']).toBe('flat');
  });
});
