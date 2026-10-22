import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { decodeMimeWords } from './rfc2047.js';

export const PROXY_SECRET_HEADER = 'x-harmony-proxy-secret';
export const DEV_LOGIN_COOKIE = 'dev_login';

export interface AuthPolicy {
  proxySecret?: string | undefined;
  publicOrigin: string;
  allowedLogins: readonly string[];
  /** Fixed identity for local development. Only ever set when NODE_ENV=development. */
  devIdentity?: Identity | undefined;
}

export interface Identity {
  login: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface AuthFailure {
  statusCode: 401 | 403;
  code: 'proxy_required' | 'funnel_not_allowed' | 'no_identity' | 'not_allowed' | 'bad_origin';
  message: string;
}

export interface RequestInfo {
  method: string;
  headers: IncomingHttpHeaders;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_LOGIN_LENGTH = 254;
const MAX_NAME_LENGTH = 100;

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Constant-time comparison; hashing first makes the buffers equal length. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function hasValidProxySecret(
  headers: IncomingHttpHeaders,
  expected: string | undefined,
): boolean {
  const provided = header(headers, PROXY_SECRET_HEADER);
  return Boolean(expected) && provided !== undefined && safeEqual(provided, expected ?? '');
}

export function isWebSocketUpgrade(headers: IncomingHttpHeaders): boolean {
  return header(headers, 'upgrade')?.toLowerCase() === 'websocket';
}

export function requiresOriginCheck({ method, headers }: RequestInfo): boolean {
  return !SAFE_METHODS.has(method.toUpperCase()) || isWebSocketUpgrade(headers);
}

/** Exact match on the normalized origin; a missing or malformed Origin never matches. */
export function isAllowedOrigin(origin: string | undefined, publicOrigin: string): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(publicOrigin).origin;
  } catch {
    return false;
  }
}

export function parseIdentity(headers: IncomingHttpHeaders): Identity | null {
  const login = header(headers, 'tailscale-user-login')?.trim().toLowerCase();
  if (!login || login.length > MAX_LOGIN_LENGTH) return null;

  const decodedName = decodeMimeWords(header(headers, 'tailscale-user-name') ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  const picture = header(headers, 'tailscale-user-profile-pic');

  return {
    login,
    displayName: decodedName || login.split('@')[0] || login,
    avatarUrl: picture && /^https?:\/\//i.test(picture) ? picture : null,
  };
}

const DEV_LOGIN = /^[a-z0-9._+-]{1,64}@example\.com$/;

function cookie(headers: IncomingHttpHeaders, name: string): string | undefined {
  for (const part of (header(headers, 'cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

/**
 * Development only: the `dev_login` cookie picks which `@example.com` user a browser acts as,
 * so two browser contexts can be two people. Callers must only use it with a dev policy.
 */
export function devIdentityFor(headers: IncomingHttpHeaders, fallback: Identity): Identity {
  let login: string | undefined;
  try {
    login = cookie(headers, DEV_LOGIN_COOKIE)?.toLowerCase();
  } catch {
    return fallback;
  }
  if (!login || !DEV_LOGIN.test(login)) return fallback;
  const name = login.split('@')[0] ?? login;
  return { login, displayName: name.charAt(0).toUpperCase() + name.slice(1), avatarUrl: null };
}

export function authenticate(request: RequestInfo, policy: AuthPolicy): Identity | AuthFailure {
  const { headers } = request;
  const fail = (
    statusCode: AuthFailure['statusCode'],
    code: AuthFailure['code'],
    message: string,
  ): AuthFailure => ({ statusCode, code, message });

  let identity: Identity | null;
  if (policy.devIdentity) {
    identity = devIdentityFor(headers, policy.devIdentity);
  } else {
    if (!hasValidProxySecret(headers, policy.proxySecret)) {
      return fail(403, 'proxy_required', 'Requests must come through the reverse proxy');
    }
    if (headers['tailscale-funnel-request'] !== undefined) {
      return fail(403, 'funnel_not_allowed', 'Public Funnel access is not permitted');
    }
    identity = parseIdentity(headers);
    if (!identity) return fail(401, 'no_identity', 'No Tailscale user identity on the request');
  }

  if (policy.allowedLogins.length > 0 && !policy.allowedLogins.includes(identity.login)) {
    return fail(403, 'not_allowed', 'This account is not allowed to use this server');
  }
  if (
    requiresOriginCheck(request) &&
    !isAllowedOrigin(header(headers, 'origin'), policy.publicOrigin)
  ) {
    return fail(403, 'bad_origin', 'Origin not allowed');
  }
  return identity;
}

export function isAuthFailure(result: Identity | AuthFailure): result is AuthFailure {
  return 'statusCode' in result;
}
