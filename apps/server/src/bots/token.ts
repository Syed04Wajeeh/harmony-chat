import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BOT_TOKEN_PATTERN } from '@harmony/shared';

/** 32 random bytes as base64url: exactly 43 characters. */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/** Constant-time comparison of a presented secret with its stored hash. */
export function verifySecret(secret: string, storedHash: Buffer): boolean {
  const given = hashSecret(secret);
  return given.length === storedHash.length && timingSafeEqual(given, storedHash);
}

export const formatBotToken = (botId: string, secret: string): string => `hb_${botId}_${secret}`;

export interface ParsedBotToken {
  botId: string;
  secret: string;
}

export function parseBotToken(token: string): ParsedBotToken | null {
  const match = BOT_TOKEN_PATTERN.exec(token);
  return match ? { botId: match[1] as string, secret: match[2] as string } : null;
}

export const generateSigningSecret = (): string => `hsk_${generateSecret()}`;
