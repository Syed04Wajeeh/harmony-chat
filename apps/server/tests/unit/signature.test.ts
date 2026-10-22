import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sign, verifySignature } from '@harmony/shared/signature';

const secret = 'hsk_test-secret';
const body = JSON.stringify({ hello: 'world' });
const now = 1_800_000_000;

describe('request signatures', () => {
  it('signs as v1=hex(hmac-sha256(secret, "<timestamp>.<body>"))', () => {
    const expected = createHmac('sha256', secret).update(`${now}.${body}`).digest('hex');
    expect(sign(secret, now, body)).toBe(`v1=${expected}`);
  });

  it('verifies a fresh, untouched request', () => {
    const signature = sign(secret, now, body);
    expect(verifySignature({ secret, timestamp: String(now), signature, body, now })).toBe(true);
  });

  it('accepts raw bytes as well as strings', () => {
    const signature = sign(secret, now, body);
    const bytes = new TextEncoder().encode(body);
    expect(verifySignature({ secret, timestamp: String(now), signature, body: bytes, now })).toBe(
      true,
    );
  });

  it('rejects a tampered body, timestamp, signature or secret', () => {
    const signature = sign(secret, now, body);
    const base = { secret, timestamp: String(now), signature, body, now };
    expect(verifySignature({ ...base, body: body + ' ' })).toBe(false);
    expect(verifySignature({ ...base, timestamp: String(now + 1) })).toBe(false);
    expect(verifySignature({ ...base, signature: signature.replace(/.$/, '0') })).toBe(false);
    expect(verifySignature({ ...base, signature: signature.slice(3) })).toBe(false);
    expect(verifySignature({ ...base, signature: signature + '00' })).toBe(false);
    expect(verifySignature({ ...base, secret: 'other' })).toBe(false);
  });

  it('rejects missing or malformed headers', () => {
    const signature = sign(secret, now, body);
    expect(verifySignature({ secret, timestamp: undefined, signature, body, now })).toBe(false);
    expect(
      verifySignature({ secret, timestamp: String(now), signature: undefined, body, now }),
    ).toBe(false);
    expect(verifySignature({ secret, timestamp: 'abc', signature, body, now })).toBe(false);
    expect(verifySignature({ secret, timestamp: `${now}.5`, signature, body, now })).toBe(false);
  });

  it('allows five minutes of skew either way and no more', () => {
    const at = (offset: number) => {
      const timestamp = now + offset;
      return verifySignature({
        secret,
        timestamp: String(timestamp),
        signature: sign(secret, timestamp, body),
        body,
        now,
      });
    };
    expect(at(-300)).toBe(true);
    expect(at(300)).toBe(true);
    expect(at(-301)).toBe(false);
    expect(at(301)).toBe(false);
    expect(at(-86_400)).toBe(false);
  });

  it('honors a custom tolerance', () => {
    const timestamp = now - 30;
    const signature = sign(secret, timestamp, body);
    const input = { secret, timestamp: String(timestamp), signature, body, now };
    expect(verifySignature({ ...input, toleranceSeconds: 10 })).toBe(false);
    expect(verifySignature({ ...input, toleranceSeconds: 60 })).toBe(true);
  });
});
