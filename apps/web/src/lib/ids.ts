/** Ids are decimal strings; compare numerically without losing precision. */
export function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export const maxId = (a: string | null | undefined, b: string | null | undefined): string | null =>
  a == null ? (b ?? null) : b == null ? a : compareIds(a, b) >= 0 ? a : b;
