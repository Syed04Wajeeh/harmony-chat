import { invoke } from '@tauri-apps/api/core';
import type { Call } from './connect.js';

const ICONS = {
  minimize: '<path d="M0 5.5h10" />',
  maximize: '<rect x="0.5" y="0.5" width="9" height="9" rx="1" />',
  restore:
    '<rect x="0.5" y="2.5" width="7" height="7" rx="1" /><path d="M2.5 2.5v-1a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />',
  close: '<path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />',
} as const;

const icon = (name: keyof typeof ICONS) =>
  `<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

/** The native title bar is off on Windows (see the web client's TitleBar); the setup page draws the same one. */
export const needsTitleBar = (agent = navigator.userAgent): boolean => /Windows/.test(agent);

export function mountTitleBar(slot: HTMLElement, call: Call = invoke): void {
  document.documentElement.dataset['titlebar'] = '';
  slot.innerHTML = `
    <header class="titlebar">
      <div class="titlebar-drag">
        <img src="/icon.svg" alt="" width="16" height="16" />
        <span>Harmony</span>
      </div>
      <div class="titlebar-controls">
        <button type="button" aria-label="Minimize" data-command="window_minimize">${icon('minimize')}</button>
        <button type="button" id="maximize" aria-label="Maximize" data-command="window_toggle_maximize">${icon('maximize')}</button>
        <button type="button" class="titlebar-close" aria-label="Close" data-command="window_close">${icon('close')}</button>
      </div>
    </header>`;

  const send = (command: string) => void call(command).catch(() => undefined);
  const maximize = slot.querySelector<HTMLButtonElement>('#maximize');

  for (const button of slot.querySelectorAll<HTMLButtonElement>('button[data-command]')) {
    button.addEventListener('click', () => send(button.dataset['command'] ?? ''));
  }
  slot.querySelector('.titlebar-drag')?.addEventListener('mousedown', (event) => {
    const mouse = event as MouseEvent;
    if (mouse.button !== 0) return;
    send(mouse.detail === 2 ? 'window_toggle_maximize' : 'window_start_dragging');
  });

  const refresh = () => {
    void call<boolean>('window_is_maximized')
      .then((maximized) => {
        if (!maximize) return;
        maximize.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
        maximize.innerHTML = icon(maximized ? 'restore' : 'maximize');
      })
      .catch(() => undefined);
  };
  window.addEventListener('resize', refresh);
  refresh();
}
