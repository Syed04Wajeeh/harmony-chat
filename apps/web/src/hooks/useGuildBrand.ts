import { useMemo, type CSSProperties } from 'react';
import { completeTokens, guildAccentTokens, resolveTheme } from '../lib/appearance.js';
import { useSettings } from '../store/settings.js';
import { useMediaQuery } from './useMediaQuery.js';

/**
 * Inline custom properties that recolor a subtree with a guild's accent, using the same rules as
 * the app-wide override: contrast-adjusted for the current theme, and never over a custom theme.
 * `preview` ignores the user's switch, for the editor that shows members' view.
 */
export function useGuildBrand(color: number | null, preview = false): CSSProperties | undefined {
  const appearance = useSettings((state) => state.settings.appearance);
  const customThemes = useSettings((state) => state.themes);
  const safeMode = useSettings((state) => state.safeMode);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');

  return useMemo(() => {
    if (color === null || (!preview && !appearance.useGuildAccent)) return undefined;
    const resolved = resolveTheme(appearance, { customThemes, prefersDark, safeMode });
    if (resolved.custom) return undefined;
    const tokens = guildAccentTokens(color, resolved.base, completeTokens(resolved.theme));
    if (!tokens) return undefined;
    const style: Record<string, string> = {};
    for (const [name, value] of Object.entries(tokens)) style[`--${name}`] = value;
    return style;
  }, [color, preview, appearance, customThemes, prefersDark, safeMode]);
}
