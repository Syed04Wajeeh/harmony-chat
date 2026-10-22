import { isDesktopApp, releasesUrl } from '../../lib/desktopBridge.js';
import { SettingsLayout, type SettingsNavItem } from './SettingsLayout.js';

export function UserSettingsLayout() {
  const items: SettingsNavItem[] = [
    { to: '/settings/user/appearance', label: 'Appearance', group: 'App' },
    ...(releasesUrl() && !isDesktopApp()
      ? [{ to: '/settings/user/desktop', label: 'Desktop app', group: 'App' }]
      : []),
    { to: '/settings/user/bots', label: 'My bots', group: 'Developer' },
  ];
  return <SettingsLayout title="User settings" base="/settings/user" items={items} />;
}
