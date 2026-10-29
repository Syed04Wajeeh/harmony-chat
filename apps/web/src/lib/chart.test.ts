import { describe, expect, it } from 'vitest';
import {
  formatNumber,
  isTimeAxis,
  nearestIndex,
  niceTicks,
  prepare,
  scale,
  sharedXs,
  timeTicks,
  xDomain,
  yDomain,
} from './chart.js';

describe('niceTicks', () => {
  it('picks round steps inside the range', () => {
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(3, 47)).toEqual([10, 20, 30, 40]);
    expect(niceTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it('handles an empty range', () => {
    expect(niceTicks(5, 5)).toEqual([4, 5, 6]);
  });
});

describe('formatNumber', () => {
  it('keeps axis labels short', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(0.256)).toBe('0.26');
    expect(formatNumber(12.34)).toBe('12.3');
    expect(formatNumber(100.4)).toBe('100');
    expect(formatNumber(12_500)).toBe('12.5k');
    expect(formatNumber(3_000_000)).toBe('3M');
    expect(formatNumber(-2500)).toBe('-2500');
  });
});

describe('time axes', () => {
  it('treats ISO strings and epoch milliseconds as time, small numbers as plain', () => {
    expect(isTimeAxis([{ name: 'a', points: [{ x: '2026-10-29T10:00:00Z', y: 1 }] }])).toBe(true);
    expect(isTimeAxis([{ name: 'a', points: [{ x: 1_760_000_000_000, y: 1 }] }])).toBe(true);
    expect(isTimeAxis([{ name: 'a', points: [{ x: 5, y: 1 }] }])).toBe(false);
    expect(isTimeAxis([{ name: 'a', points: [] }])).toBe(false);
  });

  it('converts ISO strings, drops bad points and sorts by x', () => {
    const [line] = prepare([
      {
        name: 'a',
        points: [
          { x: '2026-10-29T10:01:00Z', y: 2 },
          { x: '2026-10-29T10:00:00Z', y: 1 },
          { x: 'nonsense', y: 3 },
          { x: 5, y: Number.NaN },
        ],
      },
    ]);
    expect(line?.points.map((p) => p.y)).toEqual([1, 2]);
    expect(line?.points[0]?.x).toBe(Date.parse('2026-10-29T10:00:00Z'));
  });

  it('spaces ticks evenly', () => {
    expect(timeTicks({ min: 0, max: 100 }, 5)).toEqual([0, 25, 50, 75, 100]);
  });
});

describe('domains', () => {
  const lines = [
    {
      name: 'a',
      points: [
        { x: 1, y: 10 },
        { x: 2, y: 20 },
      ],
    },
  ];

  it('pads a line chart and anchors bars and areas at zero', () => {
    const line = yDomain(lines, { kind: 'line' });
    expect(line.min).toBeLessThan(10);
    expect(line.max).toBeGreaterThan(20);
    expect(yDomain(lines, { kind: 'bar' })).toEqual({ min: 0, max: 20 });
    expect(yDomain(lines, { kind: 'area' }).min).toBe(0);
  });

  it('lets yMin and yMax win', () => {
    expect(yDomain(lines, { kind: 'line', yMin: 0, yMax: 100 })).toEqual({ min: 0, max: 100 });
  });

  it('copes with no data and flat data', () => {
    expect(yDomain([], { kind: 'line' })).toEqual({ min: 0, max: 1 });
    const flat = yDomain([{ name: 'a', points: [{ x: 1, y: 5 }] }], { kind: 'line' });
    expect(flat.max).toBeGreaterThan(flat.min);
    expect(xDomain([])).toEqual({ min: 0, max: 1 });
    expect(xDomain([{ name: 'a', points: [{ x: 3, y: 1 }] }]).max).toBeGreaterThan(3);
  });
});

describe('scale and hover', () => {
  it('maps a domain onto a range, including inverted ranges for y', () => {
    const x = scale({ min: 0, max: 10 }, 0, 100);
    expect(x(5)).toBe(50);
    const y = scale({ min: 0, max: 10 }, 100, 0);
    expect(y(0)).toBe(100);
    expect(y(10)).toBe(0);
  });

  it('finds the nearest x', () => {
    const xs = [0, 10, 20, 40];
    expect(nearestIndex(xs, -5)).toBe(0);
    expect(nearestIndex(xs, 14)).toBe(1);
    expect(nearestIndex(xs, 16)).toBe(2);
    expect(nearestIndex(xs, 31)).toBe(3);
    expect(nearestIndex(xs, 99)).toBe(3);
    expect(nearestIndex([], 1)).toBe(-1);
  });

  it('merges the x values of several lines', () => {
    expect(
      sharedXs([
        { name: 'a', points: [{ x: 3, y: 1 }] },
        {
          name: 'b',
          points: [
            { x: 1, y: 1 },
            { x: 3, y: 2 },
          ],
        },
      ]),
    ).toEqual([1, 3]);
  });
});
