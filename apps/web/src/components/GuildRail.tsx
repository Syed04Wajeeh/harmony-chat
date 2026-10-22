import { useState } from 'react';
import { NavLink } from 'react-router';
import { guildPath, homePath, HOME } from '../lib/paths.js';
import { dmUnread, guildUnread, sortGuilds } from '../store/selectors.js';
import { useApp } from '../store/store.js';
import { CreateGuildDialog } from './dialogs/CreateGuildDialog.js';
import { GuildIcon } from './Avatar.js';
import { ChatIcon, PlusIcon } from './Icons.js';

interface RailItemProps {
  to: string;
  label: string;
  active: boolean;
  unread: boolean;
  mentions: number;
  children: React.ReactNode;
}

function RailItem({ to, label, active, unread, mentions, children }: RailItemProps) {
  return (
    <li className="rail-item" data-active={active || undefined}>
      <span className="rail-pill" data-unread={unread && !active ? '' : undefined} />
      <NavLink
        to={to}
        className="rail-button"
        aria-label={mentions > 0 ? `${label}, ${String(mentions)} mentions` : label}
        aria-current={active ? 'page' : undefined}
        title={label}
      >
        {children}
      </NavLink>
      {mentions > 0 && (
        <span className="badge rail-badge" aria-hidden="true">
          {mentions >= 100 ? '99+' : mentions}
        </span>
      )}
    </li>
  );
}

export function GuildRail({ activeGuildId }: { activeGuildId: string | null }) {
  const guilds = useApp((state) => state.guilds);
  const channels = useApp((state) => state.channels);
  const [creating, setCreating] = useState(false);
  const all = Object.values(channels);
  const dms = dmUnread(all);

  return (
    <nav className="guild-rail" aria-label="Servers">
      <ul>
        <RailItem
          to={homePath(all)}
          label="Direct messages"
          active={activeGuildId === HOME}
          unread={dms.unread}
          mentions={dms.mentions}
        >
          <span className="guild-icon guild-icon-home">
            <ChatIcon width={24} height={24} />
          </span>
        </RailItem>
        <li className="rail-divider" role="separator" />
        {sortGuilds(Object.values(guilds)).map((guild) => {
          const summary = guildUnread(all, guild.id);
          return (
            <RailItem
              key={guild.id}
              to={guildPath(guild.id, all)}
              label={guild.name}
              active={activeGuildId === guild.id}
              unread={summary.unread}
              mentions={summary.mentions}
            >
              <GuildIcon guild={guild} />
            </RailItem>
          );
        })}
        <li className="rail-item">
          <button
            className="rail-button rail-add"
            aria-label="Create a server"
            title="Create a server"
            onClick={() => setCreating(true)}
          >
            <PlusIcon width={24} height={24} />
          </button>
        </li>
      </ul>
      <CreateGuildDialog open={creating} onOpenChange={setCreating} />
    </nav>
  );
}
