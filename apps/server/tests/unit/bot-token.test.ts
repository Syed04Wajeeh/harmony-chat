import { describe, expect, it } from 'vitest';
import {
  formatBotToken,
  generateSecret,
  generateSigningSecret,
  hashSecret,
  parseBotToken,
  verifySecret,
} from '../../src/bots/token.js';
import { botCredential } from '../../src/auth/policy.js';

describe('bot tokens', () => {
  it('generates 43-character base64url secrets that differ every time', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(a);
    expect(generateSigningSecret()).toMatch(/^hsk_[A-Za-z0-9_-]{43}$/);
  });

  it('round-trips hb_<id>_<secret>', () => {
    const secret = generateSecret();
    const token = formatBotToken('42', secret);
    expect(token).toBe(`hb_42_${secret}`);
    expect(parseBotToken(token)).toEqual({ botId: '42', secret });
  });

  it.each([
    '',
    'hb_',
    'hb__' + 'a'.repeat(43),
    'hb_x_' + 'a'.repeat(43),
    'hb_1_' + 'a'.repeat(42),
    'hb_1_' + 'a'.repeat(44),
    'hb_1_' + 'a'.repeat(42) + '!',
    'xx_1_' + 'a'.repeat(43),
    'hb_1234567890123456789_' + 'a'.repeat(43),
    ' hb_1_' + 'a'.repeat(43),
    'hb_1_' + 'a'.repeat(43) + '\n',
  ])('rejects malformed token %j', (token) => {
    expect(parseBotToken(token)).toBeNull();
  });

  it('stores a 32-byte sha256 and verifies it', () => {
    const secret = generateSecret();
    const hash = hashSecret(secret);
    expect(hash).toHaveLength(32);
    expect(hash.toString('hex')).not.toContain(secret);
    expect(verifySecret(secret, hash)).toBe(true);
    expect(verifySecret(generateSecret(), hash)).toBe(false);
    expect(verifySecret(secret, hash.subarray(0, 16))).toBe(false);
  });

  it('extracts only the Bot scheme from Authorization', () => {
    expect(botCredential({ authorization: 'Bot abc' })).toBe('abc');
    expect(botCredential({ authorization: 'bot   abc ' })).toBe('abc');
    expect(botCredential({ authorization: 'Bearer abc' })).toBeNull();
    expect(botCredential({ authorization: 'Bot' })).toBe('');
    expect(botCredential({ authorization: 'Botany abc' })).toBeNull();
    expect(botCredential({})).toBeNull();
  });
});
