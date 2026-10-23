import { useApp } from '../../store/store.js';
import { webModules } from '../../modules/index.js';
import { isDesktopApp, releasesUrl } from '../../lib/desktopBridge.js';
import { SettingsLayout, type SettingsNavItem } from './SettingsLayout.js';

export function UserSettingsLayout() {
  const isAdmin = useApp((state) => state.me?.isAdmin ?? false);
  const items: SettingsNavItem[] = [
    { to: '/settings/user/profile', label: 'Profile', group: 'Account' },
    { to: '/settings/user/appearance', label: 'Display', group: 'Appearance' },
    { to: '/settings/user/themes', label: 'Themes', group: 'Appearance' },
    { to: '/settings/user/advanced', label: 'Advanced', group: 'Appearance' },
    { to: '/settings/user/behavior', label: 'Behavior', group: 'App' },
    ...(releasesUrl() && !isDesktopApp()
      ? [{ to: '/settings/user/desktop', label: 'Desktop app', group: 'App' }]
      : []),
    { to: '/settings/user/bots', label: 'My bots', group: 'Developer' },
    ...(isAdmin ? [{ to: '/settings/user/perks', label: 'Perks', group: 'Instance' }] : []),
    ...webModules.flatMap((module) =>
      module.userSettingsPanel
        ? [
            {
              to: `/settings/user/m/${module.id}`,
              label: module.userSettingsPanel.label,
              group: 'Modules',
            },
          ]
        : [],
    ),
  ];
  return <SettingsLayout title="User settings" base="/settings/user" items={items} />;
}
