import { useEffect } from 'react';
import { getRealtime } from '../store/connection.js';
import { useSettings } from '../store/settings.js';

const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const;

/**
 * Tells the server whether THIS device is idle, after the chosen quiet time (0 never). The
 * server decides what the user shows: idle only when their chosen status is online and every
 * connected device is idle, so a quiet phone cannot turn off a busy desktop. A frame is sent
 * only when the flag changes. A hidden tab gets no interaction, so it goes idle on the same
 * timer; becoming visible or focused counts as activity.
 */
export function useAutoIdle(): void {
  const minutes = useSettings((state) => state.settings.behavior.autoIdleMinutes);
  useEffect(() => {
    if (minutes === 0) return undefined;
    const realtime = getRealtime();
    let idle = false;
    /** Whether the server's copy of this socket's flag matches `idle`. */
    let reported = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const setIdle = (next: boolean) => {
      if (idle === next) return;
      idle = next;
      reported = realtime.send({ type: 'presence.activity', idle });
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), minutes * 60 * 1000);
    };
    const onActivity = () => {
      if (document.visibilityState === 'hidden') return;
      setIdle(false);
      arm();
    };
    // A new socket starts active on the server, so an idle device says so again after reconnecting.
    const offStatus = realtime.onStatus((status) => {
      if (status !== 'open') reported = !idle;
      else if (idle && !reported) reported = realtime.send({ type: 'presence.activity', idle });
    });

    arm();
    for (const name of EVENTS) window.addEventListener(name, onActivity, { passive: true });
    document.addEventListener('visibilitychange', onActivity);
    return () => {
      clearTimeout(timer);
      offStatus();
      for (const name of EVENTS) window.removeEventListener(name, onActivity);
      document.removeEventListener('visibilitychange', onActivity);
      if (idle) realtime.send({ type: 'presence.activity', idle: false });
    };
  }, [minutes]);
}
