import { useEffect } from 'react';

const KEYBOARD_THRESHOLD_PX = 120;

/**
 * Keeps `--app-height` and `--app-top` equal to the visual viewport, so the app (and the
 * composer pinned to its bottom) stays above the on-screen keyboard on iOS and Android.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const update = () => {
      // While pinch-zoomed the visual viewport is not the keyboard; leave the layout alone.
      if (viewport.scale > 1.01) return;
      root.style.setProperty('--app-height', `${viewport.height}px`);
      root.style.setProperty('--app-top', `${viewport.offsetTop}px`);
      root.dataset.keyboard =
        window.innerHeight - viewport.height > KEYBOARD_THRESHOLD_PX ? 'open' : 'closed';
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      for (const name of ['--app-height', '--app-top']) root.style.removeProperty(name);
      delete root.dataset.keyboard;
    };
  }, []);
}
