import { Navigate, useParams } from 'react-router';
import { useApp } from '../../store/store.js';
import { SettingsLayout } from './SettingsLayout.js';

/** Whether this person may manage a server: its owner, or an instance admin. */
export function useCanManage(guildId: string): boolean {
  return useApp((state) => {
    const guild = state.guilds[guildId];
    return guild !== undefined && (guild.ownerId === state.me?.id || state.me?.isAdmin === true);
  });
}

export function ServerSettingsLayout() {
  const { guildId = '' } = useParams();
  const guild = useApp((state) => state.guilds[guildId]);
  const canManage = useCanManage(guildId);
  if (!guild || !canManage) return <Navigate replace to="/" />;

  const base = `/settings/server/${guildId}`;
  return (
    <SettingsLayout
      title="Server settings"
      subtitle={guild.name}
      base={base}
      items={[
        { to: `${base}/overview`, label: 'Overview' },
        { to: `${base}/modules`, label: 'Modules' },
        { to: `${base}/integrations`, label: 'Integrations', group: 'Apps' },
        { to: `${base}/bots`, label: 'Bots', group: 'Apps' },
      ]}
    />
  );
}
