import type { DirectoryUser, PresenceStatus } from '@harmony/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { reportError } from '../store/actions.js';
import { useProfiles } from '../store/profiles.js';
import { appStore } from '../store/store.js';

interface Options {
  query: string;
  kind?: 'human' | 'bot';
  /** Only people outside this guild (the invite picker). */
  notInGuild?: string;
  pageSize?: number;
}

const SEARCH_DELAY_MS = 250;

/**
 * A searchable, paged view of the instance's user directory. Results also land in the shared user
 * and profile stores so avatars, profile popovers and DMs work for people you share nothing with.
 */
export function useDirectory({ query, kind = 'human', notInGuild, pageSize = 50 }: Options) {
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [total, setTotal] = useState(0);
  const [presence, setPresence] = useState<Record<string, PresenceStatus>>({});
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const loaded = useRef(0);

  const fetchPage = useCallback(
    async (offset: number, q: string, signal: AbortSignal) => {
      const mine = ++generation.current;
      setLoading(true);
      try {
        const page = await api.directory(
          { q: q.trim(), kind, notInGuild, limit: pageSize, offset },
          signal,
        );
        if (mine !== generation.current) return;
        appStore.getState().ingestUsers(page.users);
        useProfiles.getState().ingestSummaries(page.profiles);
        loaded.current = offset + page.users.length;
        setUsers((previous) => (offset === 0 ? page.users : [...previous, ...page.users]));
        setTotal(page.total);
        setPresence((previous) => ({
          ...(offset === 0 ? {} : previous),
          ...Object.fromEntries(page.presence.map((entry) => [entry.userId, entry.status])),
        }));
      } catch (error) {
        if (!signal.aborted) reportError(error, 'Could not load members');
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [kind, notInGuild, pageSize],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => void fetchPage(0, query, controller.signal),
      query ? SEARCH_DELAY_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fetchPage, query]);

  const loadMore = useCallback(() => {
    void fetchPage(loaded.current, query, new AbortController().signal);
  }, [fetchPage, query]);

  return { users, total, presence, loading, hasMore: users.length < total, loadMore };
}
