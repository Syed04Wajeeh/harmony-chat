import type { ChannelSummary } from '@harmony/shared';
import { useState } from 'react';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { useApp } from '../store/store.js';
import { useUi } from '../store/ui.js';
import { Avatar } from './Avatar.js';
import { AddMembersDialog } from './dialogs/AddMembersDialog.js';
import { HashIcon, LockIcon, MenuIcon, SearchIcon, UsersIcon } from './Icons.js';
import { PinsPopover } from './PinsPopover.js';
import { usePresenceOf } from './ProfilePopover.js';

interface Props {
  channel: ChannelSummary;
  onJump: (messageId: string) => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
}

export function ChannelHeader({ channel, onJump, searchOpen, onToggleSearch }: Props) {
  const desktop = useIsDesktop();
  const drawer = useUi((state) => state.drawer);
  const setDrawer = useUi((state) => state.setDrawer);
  const membersOpen = useUi((state) => state.membersOpen);
  const setMembersOpen = useUi((state) => state.setMembersOpen);
  const channels = useApp((state) => state.channels);
  const [adding, setAdding] = useState(false);
  const dmStatus = usePresenceOf(channel.dmUser?.id ?? '');

  const isDm = channel.kind === 'dm';
  const navBadge = Object.values(channels).reduce(
    (sum, c) =>
      sum + (c.id !== channel.id ? (c.kind === 'dm' ? c.unreadCount : c.mentionCount) : 0),
    0,
  );
  const membersShown = desktop ? membersOpen : drawer === 'right';

  return (
    <header className="channel-header">
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
            {channel.isPrivate ? (
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
        <PinsPopover channelId={channel.id} onJump={onJump} />
        <button
          className="icon-button"
          aria-label="Search"
          aria-pressed={searchOpen}
          onClick={onToggleSearch}
        >
          <SearchIcon />
        </button>
        {!isDm && (
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
