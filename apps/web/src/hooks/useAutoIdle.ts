import { useEffect } from 'react';
import { getRealtime } from '../store/connection.js';
import { appStore } from '../store/store.js';

export const IDLE_AFTER_MS = 10 * 60 * 1000;
const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** Flips an "online" user to idle after ten quiet minutes, and back on the next interaction. */
export function useAutoIdle(): void {
  useEffect(() => {
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const goIdle = () => {
      if (appStore.getState().me?.status !== 'online') return;
      idle = getRealtime().send({ type: 'presence.set', status: 'idle' });
      if (idle) appStore.setState((s) => (s.me ? { me: { ...s.me, status: 'idle' } } : s));
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(goIdle, IDLE_AFTER_MS);
    };
    const onActivity = () => {
      if (idle) {
        idle = false;
        if (getRealtime().send({ type: 'presence.set', status: 'online' })) {
          appStore.setState((s) => (s.me ? { me: { ...s.me, status: 'online' } } : s));
        }
      }
      arm();
    };

    arm();
    for (const name of EVENTS) window.addEventListener(name, onActivity, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const name of EVENTS) window.removeEventListener(name, onActivity);
    };
  }, []);
}
