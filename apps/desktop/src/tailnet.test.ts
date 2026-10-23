import { describe, expect, it, vi } from 'vitest';
import type { Call } from './connect.js';
import {
  discoverServers,
  parsePort,
  switchAccount,
  tailnetMessage,
  tailscaleStatus,
} from './tailnet.js';

describe('parsePort', () => {
  it('accepts nothing or a valid port, and rejects the rest', () => {
    expect(parsePort('')).toBeNull();
    expect(parsePort('  ')).toBeNull();
    expect(parsePort('9443')).toBe(9443);
    expect(parsePort(' 65535 ')).toBe(65535);
    for (const bad of ['0', '65536', '-1', '80a', '1.5', '999999']) {
      expect(parsePort(bad), bad).toBe('invalid');
    }
  });
});

describe('tailnetMessage', () => {
  it('names the account, and the tailnet when it differs', () => {
    expect(
      tailnetMessage({
        state: 'running',
        account: 'ada@example.com',
        tailnet: 'example.com',
        accounts: [],
      }),
    ).toBe('Signed in to Tailscale as ada@example.com (example.com).');
    expect(
      tailnetMessage({
        state: 'running',
        account: 'ada@example.com',
        tailnet: 'ada@example.com',
        accounts: [],
      }),
    ).toBe('Signed in to Tailscale as ada@example.com.');
  });
});

describe('native wrappers', () => {
  it('treat a failed status or scan as nothing found', async () => {
    const fail = vi.fn().mockRejectedValue(new Error('x')) as Call;
    expect((await tailscaleStatus(fail)).state).toBe('not_running');
    expect(await discoverServers(null, fail)).toEqual([]);
  });

  it('reports a failed switch with the CLI message and the tray hint', async () => {
    const call = vi.fn().mockRejectedValue({ code: 'failed', message: 'needs admin' }) as Call;
    const result = await switchAccount('a1', call);
    expect(result).toEqual({
      ok: false,
      message:
        'needs admin You can also switch accounts from the Tailscale icon in the system tray.',
    });
    expect(call).toHaveBeenCalledWith('tailscale_switch', { id: 'a1' });
  });
});
