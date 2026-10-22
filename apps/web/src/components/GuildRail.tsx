import { useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
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

/** Hover label to the right of a tile. Radix only opens it for a mouse or keyboard focus, never on touch. */
function RailTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" side="right" sideOffset={10}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function RailItem({ to, label, active, unread, mentions, children }: RailItemProps) {
  return (
    <li className="rail-item" data-active={active || undefined}>
      <span className="rail-pill" data-unread={unread && !active ? '' : undefined} />
      <RailTip label={label}>
        <NavLink
          to={to}
          className="rail-button"
          aria-label={mentions > 0 ? `${label}, ${String(mentions)} mentions` : label}
          aria-current={active ? 'page' : undefined}
        >
          {children}
        </NavLink>
      </RailTip>
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
    <Tooltip.Provider delayDuration={150} skipDelayDuration={300}>
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
              <ChatIcon width={22} height={22} />
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
            <RailTip label="Create a server">
              <button
                className="rail-button rail-add"
                aria-label="Create a server"
                onClick={() => setCreating(true)}
              >
                <PlusIcon width={22} height={22} />
              </button>
            </RailTip>
          </li>
        </ul>
        <CreateGuildDialog open={creating} onOpenChange={setCreating} />
      </nav>
    </Tooltip.Provider>
  );
}
