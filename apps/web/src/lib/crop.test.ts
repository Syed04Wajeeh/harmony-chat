import { describe, expect, it } from 'vitest';
import { clampOffset, cropRect, type CropState } from './crop.js';

const base: CropState = {
  viewport: 200,
  imageWidth: 800,
  imageHeight: 400,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
};

describe('crop math', () => {
  it('centres a wide image at zoom 1', () => {
    expect(cropRect(base)).toEqual({ x: 200, y: 0, size: 400 });
  });

  it('shows a smaller area when zoomed in', () => {
    expect(cropRect({ ...base, zoom: 2 })).toEqual({ x: 300, y: 100, size: 200 });
  });

  it('moves the window opposite to the drag and clamps at the edges', () => {
    expect(cropRect({ ...base, offsetX: 50 }).x).toBe(100);
    expect(cropRect({ ...base, offsetX: 10_000 }).x).toBe(0);
    expect(cropRect({ ...base, offsetX: -10_000 }).x).toBe(400);
    expect(clampOffset({ ...base, offsetY: 99 }).offsetY).toBe(0);
  });

  it('never leaves the image bounds', () => {
    for (const zoom of [1, 1.5, 4]) {
      for (const offset of [-1000, 0, 1000]) {
        const rect = cropRect({ ...base, zoom, offsetX: offset, offsetY: offset });
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.size).toBeLessThanOrEqual(base.imageWidth);
        expect(rect.y + rect.size).toBeLessThanOrEqual(base.imageHeight);
      }
    }
  });
});
