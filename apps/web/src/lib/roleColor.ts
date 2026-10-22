import type { CSSProperties } from 'react';
import { clampLightness, numberToHex, parseHexNumber, type ThemeBase } from '@harmony/shared';

/** Starting points for a role color; the editor also takes any hex value. */
export const ROLE_PALETTE: readonly number[] = [
  0xe5534b, 0xe0823d, 0xd4a72c, 0x57ab5a, 0x2da58e, 0x3b9ec7, 0x539bf5, 0x7a7ff0, 0xa371f7,
  0xd264b6, 0x8b949e, 0xb08968,
];

/** Lightness bounds that keep a role color readable on each theme's surface. */
const LIGHT_THEME_MAX = 0.4;
const DARK_THEME_MIN = 0.62;

export { clampLightness };
export const toHex = numberToHex;
export const parseHex = parseHexNumber;

/** The color pulled into the lightness range that reads on the given theme base. */
export const readableColor = (color: number, base: ThemeBase): string =>
  base === 'light'
    ? clampLightness(color, 0, LIGHT_THEME_MAX)
    : clampLightness(color, DARK_THEME_MIN, 1);

/** Inline custom properties for `.role-colored`, one readable shade per theme. */
export function roleColorStyle(color: number | null | undefined): CSSProperties | undefined {
  if (color === null || color === undefined) return undefined;
  return {
    '--role-light': readableColor(color, 'light'),
    '--role-dark': readableColor(color, 'dark'),
  } as CSSProperties;
}
