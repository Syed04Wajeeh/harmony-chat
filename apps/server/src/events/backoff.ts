/**
 * Exponential backoff with full jitter: after the nth failed attempt, wait a uniformly random
 * time in [0, min(cap, base * 2^(n-1))). Full jitter spreads retries of many deliveries that
 * failed together (a bot that was down) instead of having them return in lockstep.
 */
export function backoffMs(
  failedAttempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, failedAttempt - 1));
  return Math.floor(random() * ceiling);
}
