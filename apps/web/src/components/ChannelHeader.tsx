import type { ChannelSummary } from '@harmony/shared';
import { useEffect, useState } from 'react';
import { useIsDesktop, useMediaQuery } from '../hooks/useMediaQuery.js';
import { loadGuildMembers } from '../store/actions.js';
import { useApp } from '../store/store.js';
import { useUi } from '../store/ui.js';
import { Avatar } from './Avatar.js';
import { AddMembersDialog } from './dialogs/AddMembersDialog.js';
import {
  DashboardIcon,
  FeedIcon,
  HashIcon,
  LockIcon,
  MenuIcon,
  SettingsIcon,
  UsersIcon,
} from './Icons.js';
import { ChannelSettingsDialog } from './dialogs/ChannelSettingsDialog.js';
import { useGuildAccess } from '../hooks/usePermission.js';
import { ChannelHeaderSlots } from '../modules/slots.js';
import { usePresenceOf } from './ProfilePopover.js';

interface Props {
  channel: ChannelSummary;
}

/** The bots a manager assigned to the channel, and a mark when only bots may post. */
function ChannelBots({ channel }: { channel: ChannelSummary }) {
  const users = useApp((state) => state.users);
  const guildId = channel.guildId ?? '';
  const known = channel.botIds.every((id) => users[id]);
  useEffect(() => {
    if (!known && guildId) void loadGuildMembers(guildId);
  }, [known, guildId]);
  const bots = channel.botIds.flatMap((id) => (users[id] ? [users[id]] : []));
  // On a phone the channel name keeps priority: an icon-only feed badge and one bot avatar.
  const narrow = useMediaQuery('(max-width: 599px)');
  if (bots.length === 0 && !channel.botFeed) return null;
  const shown = narrow ? bots.slice(0, 1) : bots;
  const hidden = bots.length - shown.length;
  return (
    <ul className="channel-bots" aria-label="Bots in this channel">
      {channel.botFeed && (
        <li
          className="channel-bots-feed"
          title="Bot feed: only bots and moderators can post here"
          aria-label={narrow ? 'Bot feed: only bots and moderators can post here' : undefined}
        >
          {narrow ? <FeedIcon width={16} height={16} aria-hidden="true" /> : 'Bot feed'}
        </li>
      )}
      {shown.map((bot) => (
        <li key={bot.id} className="channel-bot" title={bot.displayName}>
          <Avatar user={bot} size={20} />
          <span>{bot.displayName}</span>
        </li>
      ))}
      {hidden > 0 && (
        <li className="channel-bot channel-bots-more" title={`${hidden} more bots`}>
          +{hidden}
        </li>
      )}
    </ul>
  );
}

export function ChannelHeader({ channel }: Props) {
  const desktop = useIsDesktop();
  const drawer = useUi((state) => state.drawer);
  const setDrawer = useUi((state) => state.setDrawer);
  const membersOpen = useUi((state) => state.membersOpen);
  const setMembersOpen = useUi((state) => state.setMembersOpen);
  const channels = useApp((state) => state.channels);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const guildId = channel.guildId ?? '';
  const access = useGuildAccess(guildId, channel.guildId ? channel.id : undefined);
  const me = useApp((state) => state.me?.id);
  const canEdit = access.has('manage_channels') || channel.createdBy === me;
  const canPermissions = access.has('manage_roles');
  const dmStatus = usePresenceOf(channel.dmUser?.id ?? '');

  const isDm = channel.kind === 'dm';
  // A dashboard has no messages to search or pin and no member list of its own.
  const isDashboard = channel.kind === 'dashboard';
  const navBadge = Object.values(channels).reduce(
    (sum, c) =>
      sum + (c.id !== channel.id ? (c.kind === 'dm' ? c.unreadCount : c.mentionCount) : 0),
    0,
  );
  const membersShown = desktop ? membersOpen : drawer === 'right';

  return (
    <header className="channel-header" data-harmony="channel-header">
      {!desktop && (
        <button
          className="icon-button nav-button"
          aria-label="Open navigation"
          onClick={() => setDrawer('left')}
        >
          <MenuIcon />
          {navBadge > 0 && <span className="nav-dot" aria-hidden="true" />}
        </button>
      )}
      <div className="channel-title">
        {isDm && channel.dmUser ? (
          <>
            <Avatar user={channel.dmUser} size={28} status={dmStatus} />
            <h1>{channel.dmUser.displayName}</h1>
          </>
        ) : (
          <>
            {channel.kind === 'dashboard' ? (
              <DashboardIcon width={20} height={20} />
            ) : channel.isPrivate ? (
              <LockIcon width={20} height={20} />
            ) : (
              <HashIcon width={20} height={20} />
            )}
            <h1>{channel.name}</h1>
          </>
        )}
        {channel.topic && desktop && (
          <>
            <span className="channel-topic-divider" aria-hidden="true" />
            <p className="channel-topic" title={channel.topic}>
              {channel.topic}
            </p>
          </>
        )}
      </div>
      <ChannelBots channel={channel} />
      <div className="channel-actions">
        {channel.isPrivate && channel.guildId && (
          <>
            <button
              className="icon-button"
              aria-label="Add people to channel"
              onClick={() => setAdding(true)}
            >
              <span aria-hidden="true" className="icon-plus-user">
                <UsersIcon />
                <i>+</i>
              </span>
            </button>
            <AddMembersDialog
              channelId={channel.id}
              guildId={channel.guildId}
              open={adding}
              onOpenChange={setAdding}
            />
          </>
        )}
        {!isDm && (canEdit || canPermissions) && (
          <>
            <button
              className="icon-button"
              aria-label="Channel settings"
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon />
            </button>
            {settingsOpen && (
              <ChannelSettingsDialog
                channel={channel}
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                canEdit={canEdit}
                canPermissions={canPermissions}
              />
            )}
          </>
        )}
        {!isDashboard && <ChannelHeaderSlots channelId={channel.id} />}
        {!isDm && !isDashboard && (
          <button
            className="icon-button"
            aria-label="Member list"
            aria-pressed={membersShown}
            onClick={() =>
              desktop
                ? setMembersOpen(!membersOpen)
                : setDrawer(drawer === 'right' ? null : 'right')
            }
          >
            <UsersIcon />
          </button>
        )}
      </div>
    </header>
  );
}
