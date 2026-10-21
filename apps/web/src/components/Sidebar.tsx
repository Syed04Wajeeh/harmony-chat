import type { Channel, User } from '@harmony/shared';
import type { ConnectionStatus } from '../api/realtime.js';
import { Avatar } from './Avatar.js';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  open: 'Connected',
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
};

interface SidebarProps {
  channels: Channel[];
  activeId: string;
  onSelect: (id: string) => void;
  user: User;
  status: ConnectionStatus;
}

export function Sidebar({ channels, activeId, onSelect, user, status }: SidebarProps) {
  return (
    <aside className="sidebar">
      <header className="sidebar-header">Harmony</header>
      <nav className="channel-list" aria-label="Channels">
        <h2>Text channels</h2>
        {channels.map((channel) => (
          <button
            key={channel.id}
            className={channel.id === activeId ? 'channel active' : 'channel'}
            aria-current={channel.id === activeId ? 'page' : undefined}
            onClick={() => onSelect(channel.id)}
          >
            <span className="hash">#</span>
            {channel.name}
          </button>
        ))}
      </nav>
      <footer className="user-panel">
        <Avatar user={user} size={32} />
        <div className="user-meta">
          <span className="user-name">{user.displayName}</span>
          <span className={`connection ${status}`} role="status">
            <span className="dot" />
            {STATUS_LABEL[status]}
          </span>
        </div>
      </footer>
    </aside>
  );
}
