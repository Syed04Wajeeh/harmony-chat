import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountTitleBar, needsTitleBar } from './titlebar.js';

beforeEach(() => {
  document.body.innerHTML = '<div id="slot"></div>';
  delete document.documentElement.dataset['titlebar'];
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('setup page title bar', () => {
  it('is needed on Windows only', () => {
    expect(needsTitleBar('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true);
    expect(needsTitleBar('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
  });

  it('sends the buttons and the drag region to the native window commands', async () => {
    const call = vi.fn().mockResolvedValue(false);
    mountTitleBar(document.getElementById('slot')!, call);
    expect(document.documentElement.dataset['titlebar']).toBe('');
    for (const label of ['Minimize', 'Maximize', 'Close']) {
      document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click();
    }
    const drag = document.querySelector('.titlebar-drag')!;
    drag.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 1, bubbles: true }));
    drag.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 2, bubbles: true }));
    await flush();
    expect(call.mock.calls.map((args: unknown[]) => args[0])).toEqual(
      expect.arrayContaining([
        'window_minimize',
        'window_toggle_maximize',
        'window_close',
        'window_start_dragging',
      ]),
    );
  });

  it('shows Restore while maximized', async () => {
    const call = vi.fn().mockResolvedValue(true);
    mountTitleBar(document.getElementById('slot')!, call);
    await flush();
    expect(document.getElementById('maximize')?.getAttribute('aria-label')).toBe('Restore');
  });
});
