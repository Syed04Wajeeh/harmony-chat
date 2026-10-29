import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookFormat } from '@harmony/shared';
import type { Headers } from './presets/index.js';

/** The HMAC-SHA256 senders attach, as lower-case hex of the raw request body. */
export const hmacHex = (secret: string, raw: Buffer): string =>
  createHmac('sha256', secret).update(raw).digest('hex');

function equalHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(given.trim().toLowerCase(), 'hex');
  // Malformed hex decodes short; length is not secret, content is compared in constant time.
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

/**
 * Checks the sender's signature header against the raw body. GitHub sends
 * `X-Hub-Signature-256: sha256=<hex>`; Forgejo and Gitea send `X-Forgejo-Signature` or
 * `X-Gitea-Signature` as bare hex (and also the GitHub-style header, which is accepted too).
 */
export function verifySignature(
  format: WebhookFormat,
  headers: Headers,
  raw: Buffer,
  secret: string,
): boolean {
  const expected = hmacHex(secret, raw);
  if (format === 'github') {
    const value = headers['x-hub-signature-256'];
    return value?.startsWith('sha256=') === true && equalHex(expected, value.slice(7));
  }
  if (format === 'forgejo') {
    const bare = headers['x-forgejo-signature'] ?? headers['x-gitea-signature'];
    if (bare) return equalHex(expected, bare);
    const prefixed = headers['x-hub-signature-256'];
    return prefixed?.startsWith('sha256=') === true && equalHex(expected, prefixed.slice(7));
  }
  return false;
}
