export interface CropState {
  /** Edge of the square viewport in CSS pixels. */
  viewport: number;
  imageWidth: number;
  imageHeight: number;
  /** 1 fits the shorter side to the viewport; larger zooms in. */
  zoom: number;
  /** Offset of the image centre from the viewport centre, in viewport pixels. */
  offsetX: number;
  offsetY: number;
}

export const MAX_ZOOM = 4;

export function scaleOf({ viewport, imageWidth, imageHeight, zoom }: CropState): number {
  return (viewport / Math.min(imageWidth, imageHeight)) * zoom;
}

/** Keeps the image covering the whole viewport. */
export function clampOffset(state: CropState): { offsetX: number; offsetY: number } {
  const scale = scaleOf(state);
  const limit = (size: number) => Math.max(0, (size * scale - state.viewport) / 2);
  const clamp = (value: number, max: number) => Math.min(max, Math.max(-max, value));
  return {
    offsetX: clamp(state.offsetX, limit(state.imageWidth)),
    offsetY: clamp(state.offsetY, limit(state.imageHeight)),
  };
}

/** The square of the source image the viewport shows, in source pixels. */
export function cropRect(state: CropState): { x: number; y: number; size: number } {
  const scale = scaleOf(state);
  const { offsetX, offsetY } = clampOffset(state);
  const size = state.viewport / scale;
  return {
    x: (state.imageWidth * scale - state.viewport) / 2 / scale - offsetX / scale,
    y: (state.imageHeight * scale - state.viewport) / 2 / scale - offsetY / scale,
    size,
  };
}
