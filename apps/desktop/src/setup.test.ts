import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './connect.js';
import { mountSetup } from './setup.js';

beforeEach(() => {
  document.body.innerHTML = `
    <form id="setup">
      <input id="server-url" />
      <p id="error" hidden></p>
      <button id="submit" type="submit">Connect</button>
    </form>`;
});

const submit = () =>
  document
    .querySelector<HTMLFormElement>('#setup')
    ?.dispatchEvent(new Event('submit', { cancelable: true }));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('setup page', () => {
  it('prefills the stored address', async () => {
    const call = vi.fn().mockResolvedValue('https://chat.example.ts.net/');
    await mountSetup(document, call as Call);
    expect(document.querySelector<HTMLInputElement>('#server-url')?.value).toBe(
      'https://chat.example.ts.net/',
    );
  });

  it('shows the friendly error and re-enables the form after a failure', async () => {
    const call = vi.fn((command: string) =>
      command === 'get_server_url'
        ? Promise.resolve(null)
        : Promise.reject(Object.assign(new Error('refused'), { code: 'unreachable' })),
    );
    await mountSetup(document, call as Call);
    submit();
    expect(document.querySelector<HTMLButtonElement>('#submit')?.disabled).toBe(true);
    await flush();

    const error = document.querySelector<HTMLElement>('#error');
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toBe("Can't reach the server — is Tailscale connected?");
    expect(document.querySelector<HTMLButtonElement>('#submit')?.disabled).toBe(false);
  });

  it('stays in the connecting state after success, while the window navigates away', async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    await mountSetup(document, call as Call);
    submit();
    await flush();
    const button = document.querySelector<HTMLButtonElement>('#submit');
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe('Connecting…');
    expect(document.querySelector<HTMLElement>('#error')?.hidden).toBe(true);
  });
});
