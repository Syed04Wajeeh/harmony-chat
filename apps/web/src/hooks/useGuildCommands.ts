import type { GuildCommand } from '@harmony/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';

const NONE: readonly GuildCommand[] = [];
const cache = new Map<string, readonly GuildCommand[]>();

/** The slash commands registered in a guild, from the last fetch until a fresh one lands. */
export function useGuildCommands(guildId: string | null) {
  const [commands, setCommands] = useState<readonly GuildCommand[]>(
    () => (guildId && cache.get(guildId)) || NONE,
  );

  const refresh = useCallback(() => {
    if (!guildId) return;
    api
      .guildCommands(guildId)
      .then((list) => {
        cache.set(guildId, list);
        setCommands(list);
      })
      .catch(() => {
        // Autocomplete is a convenience; without it `/` is just text.
      });
  }, [guildId]);

  useEffect(refresh, [refresh]);
  return { commands, refresh };
}
