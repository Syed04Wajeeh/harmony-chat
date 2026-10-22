import { SettingsLayout } from './SettingsLayout.js';

export function UserSettingsLayout() {
  return (
    <SettingsLayout
      title="User settings"
      base="/settings/user"
      items={[
        { to: '/settings/user/appearance', label: 'Appearance', group: 'App' },
        { to: '/settings/user/bots', label: 'My bots', group: 'Developer' },
      ]}
    />
  );
}
