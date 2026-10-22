import { useCallback } from 'react';
import { useApp } from '../store/store.js';

/** Resolves a user id to a display name, re-rendering the caller when users change. */
export function useNameOf(): (userId: string) => string | undefined {
  const users = useApp((state) => state.users);
  return useCallback((userId: string) => users[userId]?.displayName, [users]);
}
