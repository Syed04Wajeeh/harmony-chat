import { toHex } from '../lib/roleColor.js';

/** A small swatch of a role's color; the color is data, so it is set inline. */
export function RoleDot({ color }: { color: number | null }) {
  return (
    <span
      className="role-dot"
      aria-hidden="true"
      data-empty={color === null || undefined}
      style={color === null ? undefined : { backgroundColor: toHex(color) }}
    />
  );
}
