import { describe, expect, it } from 'vitest';
import { ServerFrame } from '@harmony/shared';
import { parseClientFrame } from '../../src/realtime/connection.js';

describe('parseClientFrame', () => {
  it('accepts valid frames', () => {
    expect(parseClientFrame('{"type":"subscribe","channelId":"1"}')).toEqual({
      type: 'subscribe',
      channelId: '1',
    });
    expect(
      parseClientFrame('{"type":"subscribe","channelId":"1","lastSeenId":"42"}'),
    ).toMatchObject({
      lastSeenId: '42',
    });
    expect(parseClientFrame('{"type":"unsubscribe","channelId":"1"}')).not.toBeNull();
  });

  it('trims message content', () => {
    const frame = parseClientFrame(
      '{"type":"message.send","channelId":"1","content":"  hi  ","nonce":"n1"}',
    );
    expect(frame).toMatchObject({ content: 'hi' });
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', '42'],
    ['unknown type', '{"type":"explode"}'],
    ['missing channel', '{"type":"subscribe"}'],
    ['non-numeric id', '{"type":"subscribe","channelId":"abc"}'],
    ['blank content', '{"type":"message.send","channelId":"1","content":"   ","nonce":"n"}'],
    [
      'oversized content',
      JSON.stringify({
        type: 'message.send',
        channelId: '1',
        content: 'x'.repeat(4001),
        nonce: 'n',
      }),
    ],
    [
      'oversized nonce',
      JSON.stringify({ type: 'message.send', channelId: '1', content: 'x', nonce: 'n'.repeat(65) }),
    ],
    ['missing nonce', '{"type":"message.send","channelId":"1","content":"x"}'],
  ])('rejects %s', (_name, raw) => {
    expect(parseClientFrame(raw)).toBeNull();
  });
});

describe('ServerFrame', () => {
  it('parses an error frame with a nonce', () => {
    const frame = { type: 'error', code: 'rate_limited', message: 'slow down', nonce: 'n1' };
    expect(ServerFrame.parse(frame)).toEqual(frame);
  });
});
