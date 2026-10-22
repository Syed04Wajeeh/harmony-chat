import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { api } from '../api/client.js';
import { channelPath, HOME } from '../lib/paths.js';
import { attempt } from '../store/actions.js';
import { guildChannels, sortDms } from '../store/selectors.js';
import { appStore, useApp } from '../store/store.js';
import { Avatar } from './Avatar.js';
import { CreateChannelDialog } from './dialogs/CreateChannelDialog.js';
import { GuildSettingsDialog } from './dialogs/GuildSettingsDialog.js';
import { InviteDialog } from './dialogs/InviteDialog.js';
import {
  ChevronDownIcon,
  HashIcon,
  LinkIcon,
  LockIcon,
  LogOutIcon,
  PlusIcon,
  SettingsIcon,
} from './Icons.js';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './Menu.js';
import { ConfirmDialog } from './Overlay.js';
import { UserPanel } from './UserPanel.js';

interface Props {
  guildId: string | null;
  activeChannelId: string | null;
}

export function ChannelSidebar({ guildId, activeChannelId }: Props) {
  return (
    <aside
      className="channel-sidebar"
      aria-label={guildId === HOME ? 'Direct messages' : 'Channels'}
    >
      {guildId === HOME || guildId === null ? (
        <DmList activeChannelId={activeChannelId} />
      ) : (
        <GuildChannels guildId={guildId} activeChannelId={activeChannelId} />
      )}
      <UserPanel />
    </aside>
  );
}

function Badge({ count }: { count: number }) {
  return count > 0 ? (
    <span className="badge" aria-label={`${String(count)} unread`}>
      {count >= 100 ? '99+' : count}
    </span>
  ) : null;
}

export function DmItems({ activeChannelId }: { activeChannelId: string | null }) {
  const channels = useApp((state) => state.channels);
  const presence = useApp((state) => state.presence);
  const dms = sortDms(Object.values(channels));

  return (
    <>
      {dms.length === 0 && (
        <p className="sidebar-empty">
          No conversations yet. Open someone's profile from a member list to start one.
        </p>
      )}
      <ul>
        {dms.map((dm) => (
          <li key={dm.id}>
            <NavLink
              to={channelPath(dm)}
              className="channel-link dm-link"
              data-unread={dm.unreadCount > 0 ? '' : undefined}
              aria-current={dm.id === activeChannelId ? 'page' : undefined}
            >
              {dm.dmUser && (
                <Avatar user={dm.dmUser} size={32} status={presence[dm.dmUser.id] ?? 'offline'} />
              )}
              <span className="channel-name">{dm.dmUser?.displayName ?? 'Unknown'}</span>
              <Badge count={dm.unreadCount} />
            </NavLink>
          </li>
        ))}
      </ul>
    </>
  );
}

function DmList({ activeChannelId }: { activeChannelId: string | null }) {
  return (
    <>
      <header className="sidebar-header">
        <h2>Direct messages</h2>
      </header>
      <nav className="channel-scroll" aria-label="Direct messages">
        <DmItems activeChannelId={activeChannelId} />
      </nav>
    </>
  );
}

function GuildChannels({
  guildId,
  activeChannelId,
}: {
  guildId: string;
  activeChannelId: string | null;
}) {
  const guild = useApp((state) => state.guilds[guildId]);
  const channels = useApp((state) => state.channels);
  const meId = useApp((state) => state.me?.id);
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'invite' | 'create' | 'settings' | 'leave' | null>(null);
  if (!guild) return null;
  const isOwner = guild.ownerId === meId;
  const list = guildChannels(Object.values(channels), guildId);

  async function leave() {
    const left = await attempt(
      api.leaveGuild(guildId).then(() => true),
      'Could not leave',
    );
    if (left) {
      appStore.getState().applyFrame({ type: 'guild.removed', guildId });
      void navigate('/');
    }
  }

  return (
    <>
      <Menu>
        <MenuTrigger
          className="sidebar-header sidebar-header-button"
          aria-label={`${guild.name} menu`}
        >
          <h2>{guild.name}</h2>
          <ChevronDownIcon width={18} height={18} />
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem icon={<LinkIcon />} onSelect={() => setDialog('invite')}>
            Invite people
          </MenuItem>
          <MenuItem icon={<PlusIcon />} onSelect={() => setDialog('create')}>
            Create channel
          </MenuItem>
          {isOwner && (
            <MenuItem icon={<SettingsIcon />} onSelect={() => setDialog('settings')}>
              Server settings
            </MenuItem>
          )}
          {!isOwner && (
            <>
              <MenuSeparator />
              <MenuItem danger icon={<LogOutIcon />} onSelect={() => setDialog('leave')}>
                Leave server
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>

      <nav className="channel-scroll" aria-label="Text channels">
        <div className="channel-group-header">
          <span>Text channels</span>
          <button
            className="icon-button icon-button-small"
            aria-label="Create channel"
            onClick={() => setDialog('create')}
          >
            <PlusIcon width={16} height={16} />
          </button>
        </div>
        <ul>
          {list.map((channel) => (
            <li key={channel.id}>
              <NavLink
                to={channelPath(channel)}
                className="channel-link"
                data-unread={channel.unreadCount > 0 ? '' : undefined}
                aria-current={channel.id === activeChannelId ? 'page' : undefined}
              >
                {channel.isPrivate ? (
                  <LockIcon width={18} height={18} />
                ) : (
                  <HashIcon width={18} height={18} />
                )}
                <span className="channel-name">{channel.name}</span>
                <Badge count={channel.mentionCount} />
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {dialog === 'invite' && (
        <InviteDialog
          guildId={guildId}
          guildName={guild.name}
          open
          onOpenChange={(open) => !open && setDialog(null)}
        />
      )}
      <CreateChannelDialog
        guildId={guildId}
        open={dialog === 'create'}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      {isOwner && (
        <GuildSettingsDialog
          key={guild.name + String(guild.iconUrl)}
          guild={guild}
          open={dialog === 'settings'}
          onOpenChange={(open) => !open && setDialog(null)}
        />
      )}
      <ConfirmDialog
        open={dialog === 'leave'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Leave ${guild.name}?`}
        description="You will lose access to its channels until someone invites you again."
        confirmLabel="Leave server"
        danger
        onConfirm={() => void leave()}
      />
    </>
  );
}
