import { useEffect } from 'react';
import { getRealtime } from '../store/connection.js';
import { useSettings } from '../store/settings.js';
import { appStore } from '../store/store.js';

const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** Flips an "online" user to idle after the chosen quiet time (0 never), and back on the next interaction. */
export function useAutoIdle(): void {
  const minutes = useSettings((state) => state.settings.behavior.autoIdleMinutes);
  useEffect(() => {
    if (minutes === 0) return undefined;
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const goIdle = () => {
      if (appStore.getState().me?.status !== 'online') return;
      idle = getRealtime().send({ type: 'presence.set', status: 'idle' });
      if (idle) appStore.setState((s) => (s.me ? { me: { ...s.me, status: 'idle' } } : s));
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(goIdle, minutes * 60 * 1000);
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
  }, [minutes]);
}
