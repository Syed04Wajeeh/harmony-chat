import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  combinePatches,
  mergeSettings,
  type Appearance,
  type Behavior,
  type CustomTheme,
  type SettingsPatch,
  type UserSettings,
} from '@harmony/shared';
import { api, ApiError } from '../api/client.js';
import { setTimeFormat } from '../lib/time.js';
import { reportError } from './actions.js';
import { clearLegacyAppearance, isSafeMode, readLegacyAppearance } from '../lib/appearance.js';

const SAVE_DELAY_MS = 300;
const MAX_CONFLICT_RETRIES = 3;

interface SettingsState {
  settings: UserSettings;
  themes: CustomTheme[];
  loaded: boolean;
  /** Latched at page load: `?safe` turns custom CSS and custom themes off until the page reloads. */
  safeMode: boolean;
  /** Applies a change locally at once and saves it in the background. */
  update: (patch: SettingsPatch) => void;
  /** A settings frame from another device (or the echo of this one). */
  receive: (settings: UserSettings) => void;
  setThemes: (themes: CustomTheme[]) => void;
}

/** Changes not yet confirmed by the server, folded into one request. */
let pending: SettingsPatch = {};
/** The version the server last confirmed; the next save is based on it. */
let serverVersion = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let saving = false;

export const useSettings = create<SettingsState>()((set) => ({
  settings: DEFAULT_SETTINGS,
  themes: [],
  loaded: false,
  safeMode: isSafeMode(),
  update: (patch) => {
    pending = combinePatches(pending, patch);
    set((state) => ({ settings: mergeSettings(state.settings, patch) }));
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
  },
  receive: (settings) => {
    if (settings.version <= serverVersion) return;
    serverVersion = settings.version;
    set({ settings: mergeSettings(settings, pending) });
  },
  setThemes: (themes) => set({ themes }),
}));

// Before React re-renders, so timestamps drawn in the same pass already use the new clock.
useSettings.subscribe((state) => setTimeFormat(state.settings.behavior.timeFormat));

async function flush(): Promise<void> {
  if (saving) return;
  saving = true;
  try {
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES && hasPending(); attempt++) {
      const sent = pending;
      pending = {};
      try {
        const saved = await api.patchSettings(serverVersion, sent);
        serverVersion = Math.max(serverVersion, saved.version);
        useSettings.setState({ settings: mergeSettings(saved, pending) });
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) {
          reportError(error, 'Could not save your settings');
          return;
        }
        pending = combinePatches(sent, pending);
        // Another device saved first: take its copy and replay ours on top.
        const fresh = await api.settings();
        serverVersion = fresh.version;
        useSettings.setState({ settings: mergeSettings(fresh, pending) });
      }
    }
  } finally {
    saving = false;
    if (hasPending()) timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }
}

/** A change made just before the tab closes still gets out: `keepalive` outlives the page. */
function sendPending(): void {
  if (!hasPending() || saving) return;
  const body = JSON.stringify({ version: serverVersion, ...pending });
  pending = {};
  void fetch('/api/me/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') sendPending();
});
window.addEventListener('pagehide', sendPending);

const hasPending = () => pending.appearance !== undefined || pending.behavior !== undefined;

/** Waits for unsent changes to reach the server (used by tests and before navigating away). */
export async function flushSettings(): Promise<void> {
  clearTimeout(timer);
  await flush();
}

/**
 * Fetches settings and themes once per session. A browser that still holds the old local
 * appearance choice and has nothing saved yet moves it to the server, then forgets it.
 */
export async function loadSettings(signal?: AbortSignal): Promise<void> {
  const [settings, themes] = await Promise.all([api.settings(signal), api.themes(signal)]);
  serverVersion = settings.version;
  const legacy = readLegacyAppearance();
  if (legacy) {
    if (settings.version === 0 && Object.keys(legacy).length > 0) {
      pending = combinePatches(pending, { appearance: legacy });
      timer = setTimeout(() => void flush(), 0);
    }
    clearLegacyAppearance();
  }
  useSettings.setState({ settings: mergeSettings(settings, pending), themes, loaded: true });
}

export const useAppearance = (): Appearance => useSettings((state) => state.settings.appearance);
export const useBehavior = (): Behavior => useSettings((state) => state.settings.behavior);
