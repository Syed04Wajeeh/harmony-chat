import { createHmac, timingSafeEqual } from 'node:crypto';

export const TIMESTAMP_HEADER = 'x-harmony-timestamp';
export const SIGNATURE_HEADER = 'x-harmony-signature';
export const DELIVERY_ID_HEADER = 'x-harmony-delivery-id';
/** Timestamps further than this from now are rejected, which bounds replay of a captured request. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const mac = (secret: string, timestamp: string, body: string | Uint8Array): string =>
  createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');

/** Returns the `X-Harmony-Signature` value: `v1=<hex hmac-sha256(secret, timestamp.body)>`. */
export function sign(
  secret: string,
  timestamp: number | string,
  body: string | Uint8Array,
): string {
  return `v1=${mac(secret, String(timestamp), body)}`;
}

export interface VerifyInput {
  secret: string;
  /** `X-Harmony-Timestamp` header value (unix seconds). */
  timestamp: string | undefined;
  /** `X-Harmony-Signature` header value. */
  signature: string | undefined;
  /** The raw request body, exactly as received. */
  body: string | Uint8Array;
  /** Unix seconds; injectable for tests. */
  now?: number;
  toleranceSeconds?: number;
}

/** Constant-time check of a signed request; false for a bad signature or a stale timestamp. */
export function verifySignature(input: VerifyInput): boolean {
  const { secret, timestamp, signature, body } = input;
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(timestamp)) > tolerance) return false;
  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
