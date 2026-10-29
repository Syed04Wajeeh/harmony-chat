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

describe('new client frames', () => {
  it('accepts read, typing and presence.set', () => {
    expect(parseClientFrame('{"type":"read","channelId":"1","messageId":"9"}')).not.toBeNull();
    expect(parseClientFrame('{"type":"typing","channelId":"1"}')).not.toBeNull();
    expect(parseClientFrame('{"type":"presence.set","status":"dnd"}')).not.toBeNull();
    expect(parseClientFrame('{"type":"presence.activity","idle":true}')).not.toBeNull();
  });

  it.each([
    ['unknown status', '{"type":"presence.set","status":"offline"}'],
    ['activity without a flag', '{"type":"presence.activity"}'],
    ['read without message', '{"type":"read","channelId":"1"}'],
    ['typing without channel', '{"type":"typing"}'],
  ])('rejects %s', (_name, raw) => {
    expect(parseClientFrame(raw)).toBeNull();
  });

  it('allows attachment-only messages and rejects empty ones', () => {
    const id = '3f2b8c1e-5b0a-4d0e-9a53-1c1b6f1a2b3c';
    const withFile = `{"type":"message.send","channelId":"1","content":"","nonce":"n","attachmentIds":["${id}"]}`;
    expect(parseClientFrame(withFile)).toMatchObject({ attachmentIds: [id] });
    const empty =
      '{"type":"message.send","channelId":"1","content":"","nonce":"n","attachmentIds":[]}';
    expect(parseClientFrame(empty)).toBeNull();
  });

  it('accepts reply ids and caps attachments at 10', () => {
    const reply =
      '{"type":"message.send","channelId":"1","content":"x","nonce":"n","replyToId":"5"}';
    expect(parseClientFrame(reply)).toMatchObject({ replyToId: '5' });
    const ids = Array.from({ length: 11 }, () => '"3f2b8c1e-5b0a-4d0e-9a53-1c1b6f1a2b3c"').join(
      ',',
    );
    const many = `{"type":"message.send","channelId":"1","content":"x","nonce":"n","attachmentIds":[${ids}]}`;
    expect(parseClientFrame(many)).toBeNull();
  });
});

describe('ServerFrame', () => {
  it('parses presence and typing frames', () => {
    for (const frame of [
      { type: 'presence.batch', updates: [{ userId: '1', status: 'dnd' }] },
      { type: 'typing', channelId: '1', userId: '2' },
      { type: 'guild.removed', guildId: '3' },
      { type: 'message.deleted', channelId: '1', messageId: '2' },
    ]) {
      expect(ServerFrame.parse(frame)).toEqual(frame);
    }
  });

  it('parses an error frame with a nonce', () => {
    const frame = { type: 'error', code: 'rate_limited', message: 'slow down', nonce: 'n1' };
    expect(ServerFrame.parse(frame)).toEqual(frame);
  });
});
