// Shared by the k6 scenarios. Identity: the load stack's nginx is the production user proxy, so
// requests carry `Tailscale-User-Login` and the right Origin themselves (standing in for Tailscale
// Serve, which is bypassed in load tests).
export const BASE = __ENV.BASE || 'http://127.0.0.1:8570';
export const ORIGIN = __ENV.ORIGIN || 'https://load.example.test';

export const wsUrl = () => `${BASE.replace(/^http/, 'ws')}/api/ws`;

export const loginFor = (prefix, n) => `load-${prefix}-${n}@example.com`;

export function authHeaders(login, extra) {
  return Object.assign({ 'Tailscale-User-Login': login, Origin: ORIGIN }, extra || {});
}

/** World file written by loadtest/scripts/setup.ts (read in the init context only). */
export function readWorld() {
  return JSON.parse(open(__ENV.WORLD));
}

/** Send timestamp (ms) carried in a `message.created` frame's content `k6:<ms>:<n>`, else -1. */
export function sentAtOf(data) {
  if (!data.startsWith('{"type":"message.created"')) return -1;
  const i = data.indexOf('"content":"k6:');
  if (i < 0) return -1;
  const start = i + 14;
  return Number(data.substring(start, data.indexOf(':', start)));
}
