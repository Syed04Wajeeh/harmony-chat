import type { CSSProperties } from 'react';

/** Starting points for a role color; the editor also takes any hex value. */
export const ROLE_PALETTE: readonly number[] = [
  0xe5534b, 0xe0823d, 0xd4a72c, 0x57ab5a, 0x2da58e, 0x3b9ec7, 0x539bf5, 0x7a7ff0, 0xa371f7,
  0xd264b6, 0x8b949e, 0xb08968,
];

/** Lightness bounds that keep a role color readable on each theme's surface. */
const LIGHT_THEME_MAX = 0.4;
const DARK_THEME_MIN = 0.62;

export const toHex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

export function parseHex(value: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match?.[1] ? Number.parseInt(match[1], 16) : null;
}

function toHsl(color: number): [number, number, number] {
  const r = ((color >> 16) & 255) / 255;
  const g = ((color >> 8) & 255) / 255;
  const b = (color & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60;
  return [h, s, l];
}

const hsl = ([h, s, l]: [number, number, number]) =>
  `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;

/** The color pulled into a lightness range, hue and saturation untouched. */
export function clampLightness(color: number, min: number, max: number): string {
  const [h, s, l] = toHsl(color);
  return hsl([h, s, Math.min(max, Math.max(min, l))]);
}

/** Inline custom properties for `.role-colored`, one readable shade per theme. */
export function roleColorStyle(color: number | null | undefined): CSSProperties | undefined {
  if (color === null || color === undefined) return undefined;
  return {
    '--role-light': clampLightness(color, 0, LIGHT_THEME_MAX),
    '--role-dark': clampLightness(color, DARK_THEME_MIN, 1),
  } as CSSProperties;
}
