import type { ChartBlock } from '@harmony/shared';

/** A point with its x already turned into a number (milliseconds for time axes). */
export interface Pt {
  x: number;
  y: number;
}
export interface Line {
  name: string;
  points: Pt[];
}

/** Epoch milliseconds start around 1973 at this value; smaller numbers are plain quantities. */
const EPOCH_MS_FLOOR = 1e11;

export function toNumber(x: number | string): number {
  return typeof x === 'number' ? x : Date.parse(x);
}

/** Whether x values are times: any ISO string, or numbers that only make sense as epoch ms. */
export function isTimeAxis(series: ChartBlock['series']): boolean {
  let numbers = 0;
  for (const line of series) {
    for (const point of line.points) {
      if (typeof point.x === 'string') return true;
      if (point.x >= EPOCH_MS_FLOOR) numbers++;
      else return false;
    }
  }
  return numbers > 0;
}

/** Drops points with unusable coordinates and orders each line by x. */
export function prepare(series: ChartBlock['series']): Line[] {
  return series.map((line) => ({
    name: line.name,
    points: line.points
      .map((p) => ({ x: toNumber(p.x), y: p.y }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .sort((a, b) => a.x - b.x),
  }));
}

/** Round tick values covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) {
    const base = Number.isFinite(min) ? min : 0;
    return [base - 1, base, base + 1].map((v) => round(v));
  }
  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual < 1.5 ? 1 : residual < 3 ? 2 : residual < 7 ? 5 : 10) * magnitude;
  const first = Math.ceil(min / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = first; v <= max + step * 1e-9; v += step) ticks.push(round(v));
  return ticks;
}

const round = (v: number) => Number(v.toPrecision(12));

export interface Domain {
  min: number;
  max: number;
}

/**
 * The y range: data extent padded a little, widened to include zero for bars and areas (their
 * height means something), then overridden by yMin and yMax when given.
 */
export function yDomain(
  lines: readonly Line[],
  options: { kind: ChartBlock['kind']; yMin?: number | undefined; yMax?: number | undefined },
): Domain {
  let min = Infinity;
  let max = -Infinity;
  for (const line of lines)
    for (const p of line.points) {
      if (p.y < min) min = p.y;
      if (p.y > max) max = p.y;
    }
  if (min === Infinity) return { min: options.yMin ?? 0, max: options.yMax ?? 1 };
  if (options.kind !== 'line') {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (max === min) {
    max = min + 1;
  } else if (options.kind === 'line') {
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
  }
  const lo = options.yMin ?? min;
  const hi = options.yMax ?? max;
  return hi > lo ? { min: lo, max: hi } : { min: lo, max: lo + 1 };
}

export function xDomain(lines: readonly Line[]): Domain {
  let min = Infinity;
  let max = -Infinity;
  for (const line of lines)
    for (const p of line.points) {
      if (p.x < min) min = p.x;
      if (p.x > max) max = p.x;
    }
  if (min === Infinity) return { min: 0, max: 1 };
  return max > min ? { min, max } : { min: min - 1, max: max + 1 };
}

export const scale =
  (from: Domain, r0: number, r1: number) =>
  (v: number): number =>
    r0 + ((v - from.min) / (from.max - from.min)) * (r1 - r0);

/** 1.2k, 3.4M, 0.25: short enough for an axis label. */
export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e4) return `${trim(value / 1e3)}k`;
  if (abs >= 100) return trim(value, 0);
  if (abs >= 1) return trim(value, 1);
  return trim(value, 2);
}

function trim(value: number, digits = 1): string {
  return value.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
}

const DAY = 86_400_000;

/** Evenly spaced x positions for a time axis. */
export function timeTicks(domain: Domain, count: number): number[] {
  const step = (domain.max - domain.min) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => domain.min + step * i);
}

/** Time of day for short spans, date for long ones. */
export function formatTime(ms: number, spanMs: number, locale?: string): string {
  const date = new Date(ms);
  if (spanMs <= 2 * DAY) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/** Full date and time for the tooltip. */
export function formatFullTime(ms: number, locale?: string): string {
  return new Date(ms).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Index of the entry in a sorted list closest to `target`. */
export function nearestIndex(sorted: readonly number[], target: number): number {
  if (sorted.length === 0) return -1;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  const prev = lo > 0 ? lo - 1 : lo;
  return Math.abs((sorted[prev] ?? 0) - target) <= Math.abs((sorted[lo] ?? 0) - target) ? prev : lo;
}

/** Every distinct x across the lines, ascending: the stops a hover can land on. */
export function sharedXs(lines: readonly Line[]): number[] {
  const xs = new Set<number>();
  for (const line of lines) for (const p of line.points) xs.add(p.x);
  return [...xs].sort((a, b) => a - b);
}

/** The line's y at exactly `x`, if it has a point there. */
export function valueAt(line: Line, x: number): number | undefined {
  return line.points.find((p) => p.x === x)?.y;
}
