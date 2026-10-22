import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const DESKTOP_QUERY = '(min-width: 900px)';
export const useIsDesktop = () => useMediaQuery(DESKTOP_QUERY);
/** True on touch-first devices, where Enter inserts a newline instead of sending. */
export const useCoarsePointer = () => useMediaQuery('(pointer: coarse)');
export const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
