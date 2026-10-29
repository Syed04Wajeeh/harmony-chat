import { useEffect } from 'react';
import { ownShownStatus } from '../lib/presence.js';
import type { Role } from '@harmony/shared';
import { memberColor } from '../hooks/usePermission.js';
import { roleColorStyle } from '../lib/roleColor.js';
import { loadChannelMembers, loadGuildMembers, loadRoles } from '../store/actions.js';
import { useApp } from '../store/store.js';
import { Avatar } from './Avatar.js';
import { AuthorBadge } from './AuthorBadge.js';
import { ProfilePopover, usePresenceOf } from './ProfilePopover.js';

function MemberRow({ userId, guildId }: { userId: string; guildId: string }) {
  const user = useApp((state) => state.users[userId]);
  const nickname = useApp((state) => state.memberInfo[guildId]?.[userId]?.nickname);
  const color = useApp((state) => memberColor(state, guildId, userId));
  const status = usePresenceOf(userId);
  if (!user) return null;
  return (
    <li>
      <ProfilePopover userId={userId}>
        <button className="member-row" data-offline={status === 'offline' ? '' : undefined}>
          <Avatar user={user} size={36} status={status} />
          <span
            className="member-name"
            data-role={color !== null || undefined}
            style={roleColorStyle(color)}
          >
            {nickname || user.displayName}
          </span>
          {user.isBot && <AuthorBadge kind="bot" />}
        </button>
      </ProfilePopover>
    </li>
  );
}

interface Section {
  key: string;
  title: string;
  ids: string[];
}

export function MemberList({ guildId, channelId }: { guildId: string; channelId: string }) {
  const channel = useApp((state) => state.channels[channelId]);
  const guildMembers = useApp((state) => state.guildMembers[guildId]);
  const channelMembers = useApp((state) => state.channelMembers[channelId]);
  const roles = useApp((state) => state.roles[guildId]);
  const info = useApp((state) => state.memberInfo[guildId]);
  const users = useApp((state) => state.users);
  const presence = useApp((state) => state.presence);
  const me = useApp((state) => state.me);
  const isPrivate = channel?.isPrivate ?? false;

  useEffect(() => {
    void loadGuildMembers(guildId);
    if (isPrivate) void loadChannelMembers(channelId);
  }, [isPrivate, channelId, guildId]);
  useEffect(() => {
    if (!roles) void loadRoles(guildId);
  }, [roles, guildId]);

  const ids = (isPrivate ? channelMembers : guildMembers) ?? [];
  const statusOf = (id: string) =>
    id === me?.id ? ownShownStatus(me.status, presence[id]) : (presence[id] ?? 'offline');
  const nameOf = (id: string) => info?.[id]?.nickname || users[id]?.displayName || '';
  const sorted = ids.filter((id) => users[id]).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

  // Online members sit under their highest hoisted role; the rest under plain Online.
  const hoisted = (roles ?? []).filter((role: Role) => role.hoist);
  const sections: Section[] = hoisted.map((role) => ({ key: role.id, title: role.name, ids: [] }));
  const plainOnline: string[] = [];
  const offline: string[] = [];
  for (const id of sorted) {
    if (statusOf(id) === 'offline') {
      offline.push(id);
      continue;
    }
    const held = info?.[id]?.roleIds ?? [];
    const home = hoisted.find((role) => held.includes(role.id));
    const target = sections.find((section) => section.key === home?.id);
    (target?.ids ?? plainOnline).push(id);
  }
  sections.push({ key: 'online', title: 'Online', ids: plainOnline });
  sections.push({ key: 'offline', title: 'Offline', ids: offline });

  return (
    <aside className="member-list" data-harmony="member-list" aria-label="Members">
      <div className="member-scroll">
        {sections
          .filter((section) => section.ids.length > 0)
          .map((section) => {
            const role = hoisted.find((candidate) => candidate.id === section.key);
            return (
              <section key={section.key}>
                <h3
                  className="member-heading"
                  data-role={role?.color != null || undefined}
                  style={roleColorStyle(role?.color)}
                >
                  {section.title} <span>{section.ids.length}</span>
                </h3>
                <ul>
                  {section.ids.map((id) => (
                    <MemberRow key={id} userId={id} guildId={guildId} />
                  ))}
                </ul>
              </section>
            );
          })}
      </div>
    </aside>
  );
}
