/** localStorage that never throws (private windows, blocked storage). */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not persisted; the app works without it.
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
  },
};

const LAST_CHANNEL_KEY = 'harmony.lastChannels';

export function lastChannelFor(scope: string): string | null {
  try {
    const map = JSON.parse(safeStorage.get(LAST_CHANNEL_KEY) ?? '{}') as Record<string, string>;
    return map[scope] ?? null;
  } catch {
    return null;
  }
}

export function rememberChannel(scope: string, channelId: string): void {
  try {
    const map = JSON.parse(safeStorage.get(LAST_CHANNEL_KEY) ?? '{}') as Record<string, string>;
    safeStorage.set(LAST_CHANNEL_KEY, JSON.stringify({ ...map, [scope]: channelId }));
  } catch {
    safeStorage.set(LAST_CHANNEL_KEY, JSON.stringify({ [scope]: channelId }));
  }
}
