import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useDrawerGestures } from '../hooks/useDrawerGestures.js';
import { useUi } from '../store/ui.js';

interface Props {
  left: ReactNode;
  right: ReactNode | null;
  children: ReactNode;
}

export function DrawerLayout({ left, right, children }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const drawer = useUi((state) => state.drawer);
  const setDrawer = useUi((state) => state.setDrawer);
  useDrawerGestures(root, { rightEnabled: right !== null });

  // Opening by button (not by drag) animates through the same variables.
  useEffect(() => {
    root.current?.style.setProperty('--pl', drawer === 'left' ? '1' : '0');
    root.current?.style.setProperty('--pr', drawer === 'right' ? '1' : '0');
  }, [drawer]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setDrawer(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, setDrawer]);

  return (
    <div
      ref={root}
      className="drawer-layout"
      data-drawer={drawer ?? undefined}
      style={{ '--pl': 0, '--pr': 0 } as CSSProperties}
    >
      <div className="drawer-main" inert={drawer !== null}>
        {children}
      </div>
      <div className="drawer-backdrop" aria-hidden="true" onClick={() => setDrawer(null)} />
      <div className="drawer drawer-left" inert={drawer !== 'left'}>
        {left}
      </div>
      {right && (
        <div className="drawer drawer-right" inert={drawer !== 'right'}>
          {right}
        </div>
      )}
    </div>
  );
}
