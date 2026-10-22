import { useCallback, useRef, type PointerEvent, type MouseEvent } from 'react';

const DELAY_MS = 420;
const MOVE_TOLERANCE_PX = 10;

/**
 * Touch long-press. Scrolling cancels it (the browser fires pointercancel or the finger moves),
 * and the click that follows a completed press is swallowed.
 */
export function useLongPress(onLongPress: () => void, enabled = true) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const touching = useRef(false);

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    origin.current = null;
  }, []);

  const fire = useCallback(() => {
    fired.current = true;
    cancel();
    navigator.vibrate?.(10);
    onLongPress();
  }, [cancel, onLongPress]);

  return {
    onPointerDown(event: PointerEvent) {
      touching.current = event.pointerType !== 'mouse';
      if (!enabled || !touching.current) return;
      fired.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(fire, DELAY_MS);
    },
    onPointerMove(event: PointerEvent) {
      const start = origin.current;
      if (!start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX)
        cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu(event: MouseEvent) {
      if (!enabled || !touching.current) return;
      // Android fires contextmenu for a long press; use it instead of the native menu.
      event.preventDefault();
      if (!fired.current) fire();
    },
    onClickCapture(event: MouseEvent) {
      if (fired.current) {
        fired.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}
