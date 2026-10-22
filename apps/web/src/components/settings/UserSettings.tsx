import { SettingsLayout } from './SettingsLayout.js';

export function UserSettingsLayout() {
  return (
    <SettingsLayout
      title="User settings"
      base="/settings/user"
      items={[{ to: '/settings/user/bots', label: 'My bots', group: 'Developer' }]}
    />
  );
}
