import { useEffect } from 'react';
import { loadChannelMembers, loadGuildMembers } from '../store/actions.js';
import { useApp } from '../store/store.js';
import { Avatar } from './Avatar.js';
import { AuthorBadge } from './AuthorBadge.js';
import { ProfilePopover, usePresenceOf } from './ProfilePopover.js';

function MemberRow({ userId }: { userId: string }) {
  const user = useApp((state) => state.users[userId]);
  const status = usePresenceOf(userId);
  if (!user) return null;
  return (
    <li>
      <ProfilePopover userId={userId}>
        <button className="member-row" data-offline={status === 'offline' ? '' : undefined}>
          <Avatar user={user} size={36} status={status} />
          <span className="member-name">{user.displayName}</span>
          {user.isBot && <AuthorBadge kind="bot" />}
        </button>
      </ProfilePopover>
    </li>
  );
}

export function MemberList({ guildId, channelId }: { guildId: string; channelId: string }) {
  const channel = useApp((state) => state.channels[channelId]);
  const guildMembers = useApp((state) => state.guildMembers[guildId]);
  const channelMembers = useApp((state) => state.channelMembers[channelId]);
  const users = useApp((state) => state.users);
  const presence = useApp((state) => state.presence);
  const me = useApp((state) => state.me);
  const isPrivate = channel?.isPrivate ?? false;

  useEffect(() => {
    if (isPrivate) void loadChannelMembers(channelId);
    else void loadGuildMembers(guildId);
  }, [isPrivate, channelId, guildId]);

  const ids = (isPrivate ? channelMembers : guildMembers) ?? [];
  const statusOf = (id: string) =>
    id === me?.id
      ? me.status === 'invisible'
        ? 'offline'
        : me.status
      : (presence[id] ?? 'offline');
  const sorted = ids
    .flatMap((id) => (users[id] ? [users[id]] : []))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const online = sorted.filter((user) => statusOf(user.id) !== 'offline');
  const offline = sorted.filter((user) => statusOf(user.id) === 'offline');

  return (
    <aside className="member-list" aria-label="Members">
      <div className="member-scroll">
        {online.length > 0 && (
          <section>
            <h3 className="member-heading">Online — {online.length}</h3>
            <ul>
              {online.map((user) => (
                <MemberRow key={user.id} userId={user.id} />
              ))}
            </ul>
          </section>
        )}
        {offline.length > 0 && (
          <section>
            <h3 className="member-heading">Offline — {offline.length}</h3>
            <ul>
              {offline.map((user) => (
                <MemberRow key={user.id} userId={user.id} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
