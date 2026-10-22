import { useEffect, type RefObject } from 'react';
import { useUi } from '../store/ui.js';

const EDGE_PX = 24;
const LOCK_PX = 8;
const FLING_PX_PER_MS = 0.35;

type Side = 'left' | 'right';

interface Drag {
  side: Side;
  start: number;
  startY: number;
  from: number;
  width: number;
  /** null until the finger has moved far enough to tell horizontal from vertical. */
  horizontal: boolean | null;
  progress: number;
  lastX: number;
  lastTime: number;
  velocity: number;
}

/**
 * Edge-swipe to open and drag-to-close for the two drawers. The finger drives `--pl` / `--pr`
 * (0 closed, 1 open) directly on the root, so no React renders happen during a drag. A gesture
 * that starts vertical is abandoned at once, leaving the browser to scroll.
 */
export function useDrawerGestures(
  root: RefObject<HTMLElement | null>,
  options: { rightEnabled: boolean },
): void {
  const { rightEnabled } = options;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let drag: Drag | null = null;

    const variable = (side: Side) => (side === 'left' ? '--pl' : '--pr');
    const widthOf = (side: Side) =>
      el.querySelector<HTMLElement>(`.drawer-${side}`)?.getBoundingClientRect().width ?? 300;

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      const open = useUi.getState().drawer;
      let side: Side | null = null;
      let from = 0;
      if (open) {
        side = open;
        from = 1;
      } else if (touch.clientX <= EDGE_PX) {
        side = 'left';
      } else if (rightEnabled && touch.clientX >= window.innerWidth - EDGE_PX) {
        side = 'right';
      }
      if (!side) return;
      drag = {
        side,
        start: touch.clientX,
        startY: touch.clientY,
        from,
        width: widthOf(side),
        horizontal: null,
        progress: from,
        lastX: touch.clientX,
        lastTime: event.timeStamp,
        velocity: 0,
      };
    };

    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!drag || !touch) return;
      const dx = touch.clientX - drag.start;
      const dy = touch.clientY - drag.startY;
      if (drag.horizontal === null) {
        if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
        drag.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
        if (!drag.horizontal) {
          drag = null;
          return;
        }
        el.dataset.dragging = '';
      }
      // Dragging toward the screen edge the drawer lives on opens it.
      const toward = drag.side === 'left' ? dx : -dx;
      drag.progress = Math.min(1, Math.max(0, drag.from + toward / drag.width));
      const elapsed = event.timeStamp - drag.lastTime;
      if (elapsed > 0) {
        const step = drag.side === 'left' ? touch.clientX - drag.lastX : drag.lastX - touch.clientX;
        drag.velocity = step / elapsed;
      }
      drag.lastX = touch.clientX;
      drag.lastTime = event.timeStamp;
      el.style.setProperty(variable(drag.side), String(drag.progress));
    };

    const onEnd = () => {
      if (!drag?.horizontal) {
        drag = null;
        return;
      }
      const { side, progress, velocity } = drag;
      drag = null;
      const open = velocity > FLING_PX_PER_MS || (velocity > -FLING_PX_PER_MS && progress > 0.5);
      delete el.dataset.dragging;
      el.style.setProperty(variable(side), open ? '1' : '0');
      useUi.getState().setDrawer(open ? side : null);
    };

    const onCancel = () => {
      if (!drag?.horizontal) {
        drag = null;
        return;
      }
      const { side } = drag;
      drag = null;
      delete el.dataset.dragging;
      const open = useUi.getState().drawer === side;
      el.style.setProperty(variable(side), open ? '1' : '0');
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [root, rightEnabled]);
}
