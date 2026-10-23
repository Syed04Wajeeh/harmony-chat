import type { CSSProperties } from 'react';
import { numberToHex } from '@harmony/shared';

/** Profile colors are data: they reach the CSS as custom properties, never as literals in a stylesheet. */
export function profileStyle(
  accent: number | null | undefined,
  banner?: number | null,
): CSSProperties | undefined {
  if (accent == null && banner == null) return undefined;
  return {
    ...(accent != null && { '--profile-accent': numberToHex(accent) }),
    ...(banner != null && { '--profile-banner': numberToHex(banner) }),
  } as CSSProperties;
}
