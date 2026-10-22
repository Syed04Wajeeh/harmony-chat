/** Color math shared by theme validation, the contrast checker, role colors and guild accents. */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const channel = (value: number) => clamp(Math.round(value), 0, 255);

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SEP = String.raw`(?:\s*,\s*|\s+)`;
const NUM = String.raw`\d{1,3}(?:\.\d+)?`;
const ALPHA = String.raw`(?:\s*[,/]\s*(\d{1,3}(?:\.\d+)?%?|\.\d+))?`;
const RGB = new RegExp(
  String.raw`^rgba?\(\s*(${NUM})${SEP}(${NUM})${SEP}(${NUM})${ALPHA}\s*\)$`,
  'i',
);
const HSL = new RegExp(
  String.raw`^hsla?\(\s*(-?${NUM})(?:deg)?${SEP}(${NUM})%${SEP}(${NUM})%${ALPHA}\s*\)$`,
  'i',
);

function alphaOf(text: string | undefined): number | null {
  if (text === undefined) return 1;
  const value = text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text);
  return value >= 0 && value <= 1 ? value : null;
}

/** Parses hex, rgb() and hsl() colors. Anything else, including `var()`, `url()` or trailing junk, is null. */
export function parseColor(value: string): Rgba | null {
  const text = value.trim();
  if (text.length > 48) return null;
  if (HEX.test(text)) {
    let digits = text.slice(1);
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
    const n = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 };
  }
  const rgb = RGB.exec(text);
  if (rgb) {
    const [r, g, b] = [1, 2, 3].map((i) => Number.parseFloat(rgb[i] ?? '')) as [
      number,
      number,
      number,
    ];
    const a = alphaOf(rgb[4]);
    return a === null || r > 255 || g > 255 || b > 255 ? null : { r, g, b, a };
  }
  const hsl = HSL.exec(text);
  if (hsl) {
    const [h, s, l] = [1, 2, 3].map((i) => Number.parseFloat(hsl[i] ?? '')) as [
      number,
      number,
      number,
    ];
    const a = alphaOf(hsl[4]);
    if (a === null || h < -360 || h > 360 || s > 100 || l > 100) return null;
    return { ...fromHsl(((h % 360) + 360) % 360, s / 100, l / 100), a };
  }
  return null;
}

export const isSafeColor = (value: string): boolean => parseColor(value) !== null;

export function toHex({ r, g, b, a }: Rgba): string {
  const part = (n: number) => channel(n).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}${a < 1 ? part(a * 255) : ''}`;
}

export const fromNumber = (color: number): Rgba => ({
  r: (color >> 16) & 255,
  g: (color >> 8) & 255,
  b: color & 255,
  a: 1,
});

export const numberToHex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

export function parseHexNumber(value: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match?.[1] ? Number.parseInt(match[1], 16) : null;
}

export function toHsl({ r, g, b }: Rgba): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255] as const;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === rn
      ? ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
      : max === gn
        ? ((bn - rn) / d + 2) * 60
        : ((rn - gn) / d + 4) * 60;
  return [h, s, l];
}

export function fromHsl(h: number, s: number, l: number): Omit<Rgba, 'a'> {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return { r: ((r ?? 0) + m) * 255, g: ((g ?? 0) + m) * 255, b: ((b ?? 0) + m) * 255 };
}

/** `color` pulled into a lightness range, hue and saturation untouched. Used for role and guild colors. */
export function clampLightness(color: number, min: number, max: number): string {
  const [h, s, l] = toHsl(fromNumber(color));
  return `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(clamp(l, min, max) * 100).toFixed(0)}%)`;
}

/** `top` painted over an opaque `under`. */
export function composite(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + under.r * (1 - a),
    g: top.g * a + under.g * (1 - a),
    b: top.b * a + under.b * (1 - a),
    a: 1,
  };
}

export const mix = (from: Rgba, to: Rgba, amount: number): Rgba => ({
  r: from.r + (to.r - from.r) * amount,
  g: from.g + (to.g - from.g) * amount,
  b: from.b + (to.b - from.b) * amount,
  a: 1,
});

export const withAlpha = (color: Rgba, a: number): Rgba => ({ ...color, a });

export function luminance({ r, g, b }: Rgba): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio; a translucent foreground is composited over the background first. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const bg = background.a < 1 ? composite(background, { r: 0, g: 0, b: 0, a: 1 }) : background;
  const fg = foreground.a < 1 ? composite(foreground, bg) : foreground;
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastLevel = 'AAA' | 'AA' | 'fail';

export const contrastLevel = (ratio: number, large = false): ContrastLevel =>
  ratio >= (large ? 4.5 : 7) ? 'AAA' : ratio >= (large ? 3 : 4.5) ? 'AA' : 'fail';

/**
 * Nudges the lightness of `foreground` away from the backgrounds until every one reaches `target`.
 * Direction follows whichever end of the scale has room; hue and saturation are kept.
 */
export function ensureContrast(foreground: Rgba, backgrounds: readonly Rgba[], target = 4.5): Rgba {
  const worst = (color: Rgba) => Math.min(...backgrounds.map((bg) => contrastRatio(color, bg)));
  if (worst(foreground) >= target) return foreground;
  const [h, s, l] = toHsl(foreground);
  const avg =
    backgrounds.reduce((sum, bg) => sum + luminance(composite(bg, { r: 0, g: 0, b: 0, a: 1 })), 0) /
    backgrounds.length;
  const toward = (direction: 1 | -1): Rgba | null => {
    for (let step = 1; step <= 100; step++) {
      const candidate = {
        ...fromHsl(h, s, clamp(l + (direction * step) / 100, 0, 1)),
        a: foreground.a,
      };
      if (worst(candidate) >= target) return candidate;
    }
    return null;
  };
  const preferred: 1 | -1 = avg < 0.18 ? 1 : -1;
  return toward(preferred) ?? toward(preferred === 1 ? -1 : 1) ?? foreground;
}
