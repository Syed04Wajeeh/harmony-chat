import { describe, expect, it } from 'vitest';
import { hmacHex, verifySignature } from '../../src/webhooks/signature.js';

const secret = 'correct horse battery staple';
const raw = Buffer.from('{"zen":"Keep it logically awesome."}');
const good = hmacHex(secret, raw);

describe('webhook signatures', () => {
  it('accepts GitHub X-Hub-Signature-256', () => {
    expect(
      verifySignature('github', { 'x-hub-signature-256': `sha256=${good}` }, raw, secret),
    ).toBe(true);
    expect(
      verifySignature(
        'github',
        { 'x-hub-signature-256': `sha256=${good.toUpperCase()}` },
        raw,
        secret,
      ),
    ).toBe(true);
  });

  it('accepts Forgejo and Gitea bare-hex signatures, and the GitHub-style header', () => {
    expect(verifySignature('forgejo', { 'x-forgejo-signature': good }, raw, secret)).toBe(true);
    expect(verifySignature('forgejo', { 'x-gitea-signature': good }, raw, secret)).toBe(true);
    expect(
      verifySignature('forgejo', { 'x-hub-signature-256': `sha256=${good}` }, raw, secret),
    ).toBe(true);
  });

  it('rejects missing, malformed, wrong and tampered signatures', () => {
    expect(verifySignature('github', {}, raw, secret)).toBe(false);
    expect(verifySignature('github', { 'x-hub-signature-256': good }, raw, secret)).toBe(false);
    expect(verifySignature('github', { 'x-hub-signature-256': 'sha256=zz' }, raw, secret)).toBe(
      false,
    );
    expect(verifySignature('github', { 'x-hub-signature-256': 'sha256=' }, raw, secret)).toBe(
      false,
    );
    expect(
      verifySignature(
        'github',
        { 'x-hub-signature-256': `sha256=${hmacHex('other', raw)}` },
        raw,
        secret,
      ),
    ).toBe(false);
    expect(
      verifySignature('forgejo', { 'x-gitea-signature': good }, Buffer.from('{"zen":"x"}'), secret),
    ).toBe(false);
    expect(verifySignature('forgejo', { 'x-gitea-signature': good.slice(2) }, raw, secret)).toBe(
      false,
    );
  });

  it('does not accept the Forgejo header for GitHub', () => {
    expect(verifySignature('github', { 'x-gitea-signature': good }, raw, secret)).toBe(false);
  });

  it('never verifies formats that do not sign', () => {
    expect(
      verifySignature('generic', { 'x-hub-signature-256': `sha256=${good}` }, raw, secret),
    ).toBe(false);
  });
});
