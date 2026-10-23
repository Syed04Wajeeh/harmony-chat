import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './connect.js';
import { mountSetup } from './setup.js';
import type { Account, FoundServer, KnownServer, TailnetView } from './tailnet.js';

const page = readFileSync('index.html', 'utf8');

const loadPage = () => {
  document.body.innerHTML =
    /<body>([\s\S]*)<\/body>/.exec(page)?.[1]?.replace(/<script.*?<\/script>/, '') ?? '';
};
beforeEach(loadPage);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (selector: string) => document.querySelector(selector)?.textContent ?? '';
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);

const own: FoundServer = {
  url: 'https://box.tailnet-1.ts.net:18470/',
  hostname: 'box',
  ownerLabel: 'Your device',
  warn: false,
};
const theirs: FoundServer = {
  url: 'https://grace-pc.tailnet-1.ts.net/',
  hostname: 'grace-pc',
  ownerLabel: 'Shared by grace@example.com',
  warn: true,
};
const running = (accounts: Account[] = []): TailnetView => ({
  state: 'running',
  account: 'ada@example.com',
  tailnet: 'example.com',
  accounts,
});

interface World {
  view?: TailnetView;
  found?: FoundServer[];
  recent?: KnownServer[];
  failConnect?: Record<string, unknown>;
}

function fake(world: World = {}) {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const call = vi.fn((command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    switch (command) {
      case 'tailscale_status':
        return Promise.resolve(world.view ?? running());
      case 'discover_servers':
        return Promise.resolve(world.found ?? []);
      case 'known_servers':
        return Promise.resolve(world.recent ?? []);
      case 'connect_server':
        return world.failConnect
          ? Promise.reject(Object.assign(new Error('refused'), world.failConnect))
          : Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });
  return { call: call as unknown as Call, calls };
}

describe('discovery', () => {
  it('lists what was found with its owner, and never connects by itself', async () => {
    const { call, calls } = fake({ found: [own] });
    await mountSetup(document, call);
    expect(text('#found')).toContain('box');
    expect(text('#found')).toContain('Your device');
    expect(text('#tailnet-status')).toContain('ada@example.com');
    expect(calls.some(([command]) => command === 'connect_server')).toBe(false);
  });

  it('badges devices that are not yours and asks for a deliberate click', async () => {
    const { call, calls } = fake({ found: [own, theirs] });
    await mountSetup(document, call);
    const rows = document.querySelectorAll('#found .server');
    expect(rows[0]?.hasAttribute('data-warn')).toBe(false);
    expect(rows[1]?.hasAttribute('data-warn')).toBe(true);
    expect(rows[1]?.textContent).toContain('Not your device');

    button('Connect anyway')?.click();
    await flush();
    expect(calls).toContainEqual([
      'connect_server',
      { url: theirs.url, ownerLabel: 'Shared by grace@example.com' },
    ]);
  });

  it('shows hostile names as text, not markup', async () => {
    const evil = { ...own, hostname: '<img src=x onerror=alert(1)>' };
    const { call } = fake({ found: [evil] });
    await mountSetup(document, call);
    expect(document.querySelector('#found img')).toBeNull();
    expect(text('#found')).toContain('<img src=x');
  });

  it.each([
    ['not_installed', /not installed/],
    ['not_running', /not running/],
    ['needs_login', /signed out/],
  ] as const)('explains %s and skips the scan', async (state, message) => {
    const { call, calls } = fake({ view: { state, account: null, tailnet: null, accounts: [] } });
    await mountSetup(document, call);
    expect(text('#tailnet-status')).toMatch(message);
    expect(calls.some(([command]) => command === 'discover_servers')).toBe(false);
  });

  it('says so when nothing is found and rescans on request, with the extra port', async () => {
    const { call, calls } = fake();
    await mountSetup(document, call);
    expect(text('#tailnet-status')).toContain('No Harmony servers found');

    document.querySelector<HTMLInputElement>('#extra-port')!.value = '9443';
    button('Rescan')?.click();
    await flush();
    await flush();
    expect(calls.filter(([c]) => c === 'discover_servers').map(([, a]) => a)).toEqual([
      { extraPort: null },
      { extraPort: 9443 },
    ]);
  });

  it('rejects a bad extra port without scanning', async () => {
    const { call, calls } = fake();
    await mountSetup(document, call);
    document.querySelector<HTMLInputElement>('#extra-port')!.value = 'abc';
    button('Rescan')?.click();
    await flush();
    expect(document.querySelector<HTMLElement>('#port-error')?.hidden).toBe(false);
    expect(calls.filter(([c]) => c === 'discover_servers')).toHaveLength(1);
  });
});

describe('manual entry', () => {
  it('shows the friendly error and re-enables the form after a failure', async () => {
    const { call } = fake({ failConnect: { code: 'unreachable' } });
    await mountSetup(document, call);
    document.querySelector<HTMLInputElement>('#server-url')!.value = 'chat.example.ts.net';
    document
      .querySelector<HTMLFormElement>('#setup')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(document.querySelector<HTMLButtonElement>('#submit')?.disabled).toBe(true);
    await flush();
    expect(text('#error')).toBe("Can't reach the server — is Tailscale connected?");
    expect(document.querySelector<HTMLButtonElement>('#submit')?.disabled).toBe(false);
  });

  it('stays in the connecting state after success, while the window navigates away', async () => {
    const { call } = fake();
    await mountSetup(document, call);
    document
      .querySelector<HTMLFormElement>('#setup')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const submit = document.querySelector<HTMLButtonElement>('#submit');
    expect(submit?.disabled).toBe(true);
    expect(submit?.textContent).toBe('Connecting…');
    expect(document.querySelector<HTMLElement>('#error')?.hidden).toBe(true);
  });
});

describe('recent servers', () => {
  const recent: KnownServer[] = [
    {
      url: 'https://a.example.ts.net/',
      name: 'a.example.ts.net',
      lastUsed: 2,
      ownerLabel: 'Your device',
    },
    { url: 'https://b.example.ts.net/', name: 'b.example.ts.net', lastUsed: 1, ownerLabel: null },
  ];

  it('is hidden when empty and reconnects with one click otherwise', async () => {
    await mountSetup(document, fake().call);
    expect(document.querySelector<HTMLElement>('#recent-panel')?.hidden).toBe(true);

    loadPage();
    const { call, calls } = fake({ recent });
    await mountSetup(document, call);
    expect(document.querySelector<HTMLElement>('#recent-panel')?.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('#recent button')?.click();
    await flush();
    expect(calls).toContainEqual(['connect_server', { url: 'https://a.example.ts.net/' }]);
  });

  it('forgets one entry and reloads the list', async () => {
    const { call, calls } = fake({ recent });
    await mountSetup(document, call);
    button('Forget')?.click();
    await flush();
    expect(calls).toContainEqual(['forget_server', { url: 'https://a.example.ts.net/' }]);
    expect(calls.filter(([c]) => c === 'known_servers')).toHaveLength(2);
  });
});

describe('Tailscale accounts', () => {
  const accounts: Account[] = [
    { id: 'a1', tailnet: 'example.com', account: 'ada@example.com', current: true },
    { id: 'c3', tailnet: 'example.org', account: 'grace@example.org', current: false },
  ];

  it('asks for confirmation, switches, then rescans', async () => {
    const { call, calls } = fake({ view: running(accounts) });
    await mountSetup(document, call);
    expect(text('#accounts')).toContain('Current account');

    button('Switch')?.click();
    expect(document.querySelector<HTMLElement>('#switch-confirm')?.hidden).toBe(false);
    expect(calls.some(([c]) => c === 'tailscale_switch')).toBe(false);

    document.querySelector<HTMLButtonElement>('#switch-yes')?.click();
    await flush();
    await flush();
    expect(calls).toContainEqual(['tailscale_switch', { id: 'c3' }]);
    expect(
      calls.filter(([c]) => c === 'tailscale_tailnet_status' || c === 'tailscale_status'),
    ).toHaveLength(2);
  });

  it('cancel sends nothing', async () => {
    const { call, calls } = fake({ view: running(accounts) });
    await mountSetup(document, call);
    button('Switch')?.click();
    button('Cancel')?.click();
    expect(document.querySelector<HTMLElement>('#switch-confirm')?.hidden).toBe(true);
    expect(calls.some(([c]) => c === 'tailscale_switch')).toBe(false);
  });

  it('shows the failure and points at the tray menu', async () => {
    const base = fake({ view: running(accounts) });
    const call = vi.fn((command: string, args?: Record<string, unknown>) =>
      command === 'tailscale_switch'
        ? Promise.reject(Object.assign(new Error('access denied'), { code: 'failed' }))
        : (base.call as unknown as (c: string, a?: Record<string, unknown>) => Promise<unknown>)(
            command,
            args,
          ),
    ) as unknown as Call;
    await mountSetup(document, call);
    button('Switch')?.click();
    document.querySelector<HTMLButtonElement>('#switch-yes')?.click();
    await flush();
    await flush();
    expect(text('#switch-error')).toContain('access denied');
    expect(text('#switch-error')).toContain('Tailscale icon in the system tray');
  });
});
