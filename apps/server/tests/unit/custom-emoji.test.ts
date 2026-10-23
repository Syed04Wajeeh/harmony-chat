import { describe, expect, it } from 'vitest';
import {
  findCustomEmoji,
  isJumbo,
  isStatusExpired,
  isValidEmoji,
  mapCustomEmoji,
  parseCustomEmoji,
  parsePerkList,
  statusExpiry,
  PERKS,
} from '@harmony/shared';
import { isAnimatedImage } from '../../src/uploads/animated.js';

describe('custom emoji tokens', () => {
  it('parses static and animated tokens', () => {
    expect(parseCustomEmoji('<:blob:123>')).toMatchObject({
      name: 'blob',
      id: '123',
      animated: false,
    });
    expect(parseCustomEmoji('<a:spin:9>')).toMatchObject({ animated: true });
    for (const bad of [
      '<:b:1>',
      '<:Blob:1>',
      '<:blob:>',
      '<:blob:1',
      ':blob:',
      '<:blob:1><:x:2>',
    ]) {
      expect(parseCustomEmoji(bad)).toBeNull();
    }
  });

  it('finds every token in text', () => {
    expect(findCustomEmoji('a <:one:1> b <a:two:2> <:one:1>').map((t) => t.id)).toEqual([
      '1',
      '2',
      '1',
    ]);
    expect(findCustomEmoji('no tokens < here >')).toEqual([]);
  });

  it('rewrites tokens, turning null into plain text', () => {
    expect(mapCustomEmoji('x <:keep:1> y <a:drop:2>', (t) => (t.id === '1' ? t.raw : null))).toBe(
      'x <:keep:1> y :drop:',
    );
  });

  it('validates as an emoji and stays backward compatible with stored data', () => {
    expect(isValidEmoji('<:blob:123>')).toBe(true);
    expect(isValidEmoji('<a:spin:9>')).toBe(true);
    expect(isValidEmoji(':old_shortcode:')).toBe(true);
    expect(isValidEmoji('👍')).toBe(true);
    expect(isValidEmoji('<:blob:123> ')).toBe(false);
    expect(isValidEmoji('<blob>')).toBe(false);
  });
});

describe('isJumbo', () => {
  it('is true for messages made only of emoji', () => {
    expect(isJumbo('😀')).toBe(true);
    expect(isJumbo('😀 🎉<:blob:1>  <a:spin:2>')).toBe(true);
    expect(isJumbo('👨‍👩‍👧')).toBe(true);
  });

  it('is false for text, empty messages and more than 27 emoji', () => {
    expect(isJumbo('')).toBe(false);
    expect(isJumbo('hi 😀')).toBe(false);
    expect(isJumbo('<:blob:1> text')).toBe(false);
    expect(isJumbo('😀'.repeat(27))).toBe(true);
    expect(isJumbo('😀'.repeat(28))).toBe(false);
  });
});

describe('status expiry', () => {
  const now = new Date('2026-10-23T10:15:00Z');
  it('adds the duration', () => {
    expect(statusExpiry('30m', now)?.toISOString()).toBe('2026-10-23T10:45:00.000Z');
    expect(statusExpiry('1h', now)?.toISOString()).toBe('2026-10-23T11:15:00.000Z');
    expect(statusExpiry('4h', now)?.toISOString()).toBe('2026-10-23T14:15:00.000Z');
    expect(statusExpiry('never', now)).toBeNull();
  });

  it('ends "today" at the end of the local day', () => {
    expect(statusExpiry('today', now, 0)?.toISOString()).toBe('2026-10-23T23:59:59.999Z');
    // UTC+2 (offset is minutes behind UTC, as Date#getTimezoneOffset reports it).
    expect(statusExpiry('today', now, -120)?.toISOString()).toBe('2026-10-23T21:59:59.999Z');
  });

  it('knows when a status is over', () => {
    expect(isStatusExpired(null, now)).toBe(false);
    expect(isStatusExpired('2026-10-23T10:14:59Z', now)).toBe(true);
    expect(isStatusExpired('2026-10-23T10:15:01Z', now)).toBe(false);
  });
});

describe('perk resolution', () => {
  it('reads all, none and lists', () => {
    expect(parsePerkList('all')).toEqual([...PERKS]);
    expect(parsePerkList('none')).toEqual([]);
    expect(parsePerkList('')).toEqual([]);
    expect(parsePerkList('animated_avatar, cross_server_emoji ,bogus')).toEqual([
      'animated_avatar',
      'cross_server_emoji',
    ]);
  });
});

describe('isAnimatedImage', () => {
  const frame = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x4c, 0x01, 0x00]);
  const gif = (frames: number) =>
    Buffer.concat([
      Buffer.from('GIF89a'),
      Buffer.from([1, 0, 1, 0, 0, 0, 0]),
      ...Array.from({ length: frames }, () => frame),
      Buffer.from([0x3b]),
    ]);

  it('counts GIF frames', () => {
    expect(isAnimatedImage(gif(1), 'image/gif')).toBe(false);
    expect(isAnimatedImage(gif(2), 'image/gif')).toBe(true);
  });

  it('reads the WebP animation flag', () => {
    const webp = (flags: number) => {
      const bytes = Buffer.alloc(30);
      bytes.write('RIFF', 0);
      bytes.write('WEBP', 8);
      bytes.write('VP8X', 12);
      bytes[20] = flags;
      return bytes;
    };
    expect(isAnimatedImage(webp(0x02), 'image/webp')).toBe(true);
    expect(isAnimatedImage(webp(0x10), 'image/webp')).toBe(false);
  });

  it('spots an APNG animation chunk and ignores other types', () => {
    const chunk = (type: string, length: number) => {
      const bytes = Buffer.alloc(12 + length);
      bytes.writeUInt32BE(length, 0);
      bytes.write(type, 4);
      return bytes;
    };
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(
      isAnimatedImage(
        Buffer.concat([signature, chunk('IHDR', 13), chunk('acTL', 8), chunk('IDAT', 1)]),
        'image/png',
      ),
    ).toBe(true);
    expect(
      isAnimatedImage(Buffer.concat([signature, chunk('IHDR', 13), chunk('IDAT', 1)]), 'image/png'),
    ).toBe(false);
    expect(isAnimatedImage(gif(2), 'image/jpeg')).toBe(false);
  });
});
