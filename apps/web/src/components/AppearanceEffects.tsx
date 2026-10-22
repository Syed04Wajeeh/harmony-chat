import { useEffect, useRef } from 'react';
import { applyAppearance, cacheAppearance } from '../lib/appearance.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { useSettings } from '../store/settings.js';
import { useApp } from '../store/store.js';
import { useUi } from '../store/ui.js';

/** Keeps <html> in step with the saved settings, the open guild and the OS color scheme. */
export function AppearanceEffects() {
  const appearance = useSettings((state) => state.settings.appearance);
  const customThemes = useSettings((state) => state.themes);
  const safeMode = useSettings((state) => state.safeMode);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const guildAccent = useApp((state) => {
    const channel = state.activeChannelId ? state.channels[state.activeChannelId] : undefined;
    return channel?.guildId ? (state.guilds[channel.guildId]?.accentColor ?? null) : null;
  });

  useEffect(() => {
    applyAppearance(appearance, { customThemes, prefersDark, safeMode, guildAccent });
    if (!safeMode) cacheAppearance(appearance, customThemes);
  }, [appearance, customThemes, prefersDark, safeMode, guildAccent]);

  const showAvatars = useSettings((state) => state.settings.behavior.showAvatars);
  useEffect(() => {
    document.documentElement.dataset['avatars'] = showAvatars ? 'on' : 'off';
  }, [showAvatars]);

  // The saved default only decides the first state of a browser that has not chosen for itself.
  const loaded = useSettings((state) => state.loaded);
  const memberListDefault = useSettings((state) => state.settings.behavior.memberListDefault);
  const first = useRef(true);
  useEffect(() => {
    if (!loaded) return;
    const initial = first.current;
    first.current = false;
    if (initial && hasMemberChoice()) return;
    const open = memberListDefault === 'open';
    if (initial) useUi.setState({ membersOpen: open });
    else useUi.getState().setMembersOpen(open);
  }, [loaded, memberListDefault]);

  return safeMode ? <SafeModePill /> : null;
}

function hasMemberChoice(): boolean {
  try {
    return localStorage.getItem('harmony.members') !== null;
  } catch {
    return false;
  }
}

function SafeModePill() {
  const leave = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('safe');
    window.location.assign(url);
  };
  return (
    <div className="safe-mode-pill" role="status">
      <span>Safe mode: custom themes and CSS are off</span>
      <button type="button" onClick={leave}>
        Exit
      </button>
    </div>
  );
}
