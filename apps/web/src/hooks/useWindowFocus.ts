import { useSyncExternalStore } from 'react';

const subscribe = (notify: () => void) => {
  window.addEventListener('focus', notify);
  window.addEventListener('blur', notify);
  document.addEventListener('visibilitychange', notify);
  return () => {
    window.removeEventListener('focus', notify);
    window.removeEventListener('blur', notify);
    document.removeEventListener('visibilitychange', notify);
  };
};

/** True while the tab is visible and the window has focus. */
export function useWindowFocus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState === 'visible' && document.hasFocus(),
    () => true,
  );
}
