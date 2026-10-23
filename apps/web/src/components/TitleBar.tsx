import { useEffect, useLayoutEffect, useState, type MouseEvent } from 'react';
import {
  closeWindow,
  disconnectServer,
  hasCustomTitleBar,
  isWindowMaximized,
  minimizeWindow,
  startWindowDrag,
  toggleMaximizeWindow,
} from '../lib/desktopBridge.js';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './Menu.js';
import {
  CaptionCloseIcon,
  ChevronDownIcon,
  MaximizeIcon,
  MinimizeIcon,
  RestoreIcon,
} from './Icons.js';

/** The window's title bar on Windows, where the desktop shell has none. Nothing elsewhere. */
export function TitleBar() {
  const enabled = hasCustomTitleBar();
  const [maximized, setMaximized] = useState(false);

  useLayoutEffect(() => {
    if (!enabled) return;
    document.documentElement.dataset['titlebar'] = '';
    return () => {
      delete document.documentElement.dataset['titlebar'];
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const refresh = () => {
      void isWindowMaximized().then((value) => alive && setMaximized(value));
    };
    refresh();
    window.addEventListener('resize', refresh);
    return () => {
      alive = false;
      window.removeEventListener('resize', refresh);
    };
  }, [enabled]);

  if (!enabled) return null;

  const onDragRegion = (event: MouseEvent) => {
    if (event.button !== 0) return;
    if (event.detail === 2) toggleMaximizeWindow();
    else startWindowDrag();
  };

  return (
    <header className="titlebar">
      <div className="titlebar-drag" onMouseDown={onDragRegion}>
        <img className="titlebar-icon" src="/icon.svg" alt="" width={16} height={16} />
        <span className="titlebar-title">Harmony</span>
      </div>
      <Menu>
        <MenuTrigger className="titlebar-menu" aria-label="Server menu">
          <ChevronDownIcon width={12} height={12} />
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem onSelect={disconnectServer}>Disconnect from this server</MenuItem>
        </MenuContent>
      </Menu>
      <div className="titlebar-drag" onMouseDown={onDragRegion} />
      <div className="titlebar-controls">
        <button type="button" aria-label="Minimize" onClick={minimizeWindow}>
          <MinimizeIcon />
        </button>
        <button
          type="button"
          aria-label={maximized ? 'Restore' : 'Maximize'}
          data-state={maximized ? 'maximized' : 'normal'}
          onClick={toggleMaximizeWindow}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button type="button" className="titlebar-close" aria-label="Close" onClick={closeWindow}>
          <CaptionCloseIcon />
        </button>
      </div>
    </header>
  );
}
