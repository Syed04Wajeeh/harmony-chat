import { describe, expect, it } from 'vitest';
import { clampLightness, parseHex, roleColorStyle, toHex } from './roleColor.js';

describe('role colors', () => {
  it('round-trips hex', () => {
    expect(toHex(0x0a0b0c)).toBe('#0a0b0c');
    expect(parseHex('#FF8800')).toBe(0xff8800);
    expect(parseHex('nope')).toBeNull();
  });

  it('darkens a pale color for light themes and lightens a dark one for dark themes', () => {
    expect(clampLightness(0xffffcc, 0, 0.4)).toMatch(/ 40%\)$/);
    expect(clampLightness(0x101030, 0.62, 1)).toMatch(/ 62%\)$/);
  });

  it('leaves a mid-tone alone and keeps the hue', () => {
    expect(clampLightness(0x539bf5, 0, 1)).toBe(clampLightness(0x539bf5, 0.1, 0.9));
    expect(clampLightness(0xff0000, 0, 0.4)).toMatch(/^hsl\(0 100% /);
  });

  it('sets nothing for a role without a color', () => {
    expect(roleColorStyle(null)).toBeUndefined();
    expect(Object.keys(roleColorStyle(0x539bf5) ?? {})).toEqual(['--role-light', '--role-dark']);
  });
});
