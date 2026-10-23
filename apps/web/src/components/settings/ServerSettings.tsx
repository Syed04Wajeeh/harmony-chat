import { Navigate, useParams } from 'react-router';
import { useGuildAccess } from '../../hooks/usePermission.js';
import { useApp } from '../../store/store.js';
import { SettingsLayout } from './SettingsLayout.js';

/** Permissions that make the server settings worth opening. */
const SETTINGS_KEYS = [
  'manage_guild',
  'manage_roles',
  'kick_members',
  'manage_nicknames',
  'manage_emoji',
];

/** Whether this person has anything to do in a server's settings. */
export function useCanManage(guildId: string): boolean {
  const access = useGuildAccess(guildId);
  return SETTINGS_KEYS.some((key) => access.has(key));
}

export function ServerSettingsLayout() {
  const { guildId = '' } = useParams();
  const guild = useApp((state) => state.guilds[guildId]);
  const access = useGuildAccess(guildId);
  if (!guild) return <Navigate replace to="/" />;
  // Wait for the answer instead of bouncing someone who is allowed in.
  if (!access.loaded) return null;
  if (!SETTINGS_KEYS.some((key) => access.has(key))) return <Navigate replace to="/" />;

  const base = `/settings/server/${guildId}`;
  return (
    <SettingsLayout
      title="Server settings"
      subtitle={guild.name}
      base={base}
      items={[
        ...(access.has('manage_guild') ? [{ to: `${base}/overview`, label: 'Overview' }] : []),
        ...(access.has('manage_roles') ? [{ to: `${base}/roles`, label: 'Roles' }] : []),
        { to: `${base}/members`, label: 'Members' },
        ...(access.has('manage_emoji') ? [{ to: `${base}/emoji`, label: 'Emoji' }] : []),
        ...(access.has('manage_guild')
          ? [
              { to: `${base}/modules`, label: 'Modules' },
              { to: `${base}/integrations`, label: 'Integrations', group: 'Apps' },
              { to: `${base}/bots`, label: 'Bots', group: 'Apps' },
            ]
          : []),
      ]}
    />
  );
}
