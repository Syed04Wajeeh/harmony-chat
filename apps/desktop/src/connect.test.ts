import { describe, expect, it, vi } from 'vitest';
import { connect, describeError, type Call } from './connect.js';

describe('describeError', () => {
  it('turns every native error code into a sentence', () => {
    expect(describeError({ code: 'unreachable' })).toBe(
      "Can't reach the server — is Tailscale connected?",
    );
    expect(describeError({ code: 'insecure' })).toMatch(/https/);
    expect(describeError({ code: 'not_harmony' })).toMatch(/Harmony server/);
    expect(describeError({ code: 'bad_status', status: 502 })).toBe(
      'The server answered with an error (HTTP 502).',
    );
  });

  it('falls back for anything it does not recognise', () => {
    for (const value of [undefined, 'boom', new Error('x'), { code: 'nope' }, { code: 7 }]) {
      expect(describeError(value)).toBe('Something went wrong. Please try again.');
    }
  });
});

describe('connect', () => {
  it('sends the typed address to the native command', async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    await expect(connect('https://chat.example.ts.net', call as Call)).resolves.toEqual({
      ok: true,
    });
    expect(call).toHaveBeenCalledWith('connect_server', { url: 'https://chat.example.ts.net' });
  });

  it('passes along the owner the address was picked with', async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    await connect('https://a.test', call as Call, 'Your device');
    expect(call).toHaveBeenCalledWith('connect_server', {
      url: 'https://a.test',
      ownerLabel: 'Your device',
    });
  });

  it('returns a friendly message when the command rejects', async () => {
    const call = vi.fn().mockRejectedValue({ code: 'timeout' });
    const result = await connect('x', call as Call);
    expect(result).toEqual({
      ok: false,
      message: 'The server took too long to answer — is Tailscale connected?',
    });
  });
});
