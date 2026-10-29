import * as Popover from '@radix-ui/react-popover';
import { ownShownStatus } from '../lib/presence.js';
import type { UserProfileResponse } from '@harmony/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/client.js';
import { useGuildAccess } from '../hooks/usePermission.js';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { channelPath } from '../lib/paths.js';
import { profileStyle } from '../lib/profileColor.js';
import { roleColorStyle } from '../lib/roleColor.js';
import { openDm, loadRoles } from '../store/actions.js';
import { useProfiles } from '../store/profiles.js';
import { appStore, useApp } from '../store/store.js';
import { useUi } from '../store/ui.js';
import { Avatar } from './Avatar.js';
import { EmojiValue } from './Emoji.js';
import { ChatIcon } from './Icons.js';
import { Markdown } from './Markdown.js';
import { Modal } from './Overlay.js';
import { PerkBadge } from './PerkBadge.js';

const LABELS = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Offline',
} as const;

export function usePresenceOf(userId: string) {
  return useApp((state) =>
    state.me?.id === userId
      ? ownShownStatus(state.me.status, state.presence[userId])
      : (state.presence[userId] ?? 'offline'),
  );
}

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

interface CardProps {
  userId: string;
  guildId: string | null;
  close: () => void;
}

/** The profile card shown in the popover and the phone sheet. */
export function ProfileCard({ userId, guildId, close }: CardProps) {
  const user = useApp((state) => state.users[userId]);
  const meId = useApp((state) => state.me?.id);
  const roles = useApp((state) => (guildId ? state.roles[guildId] : undefined));
  const status = usePresenceOf(userId);
  const version = useProfiles((state) => state.versions[userId] ?? 0);
  const access = useGuildAccess(guildId ?? '');
  const navigate = useNavigate();
  const [data, setData] = useState<UserProfileResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .profile(userId, guildId ?? undefined, controller.signal)
      .then(setData)
      .catch(() => undefined);
    return () => controller.abort();
  }, [userId, guildId, version]);
  useEffect(() => {
    if (guildId && !roles) void loadRoles(guildId);
  }, [guildId, roles]);

  if (!user) return null;
  const profile = data?.profile;
  const memberRoles = (roles ?? []).filter(
    (role) => data?.member?.roleIds.includes(role.id) && !role.isDefault,
  );
  const nickname = data?.member?.nickname;

  async function message() {
    const dm = await openDm(userId);
    if (!dm) return;
    close();
    useUi.getState().setDrawer(null);
    void navigate(channelPath(dm));
  }

  return (
    <div
      className="profile-card"
      data-harmony="profile-card"
      style={profileStyle(profile?.accentColor)}
    >
      <div
        className="profile-banner"
        style={
          profile?.bannerUrl
            ? { backgroundImage: `url("${profile.bannerUrl}")` }
            : profileStyle(null, profile?.bannerColor)
        }
      />
      <div className="profile-head">
        <Avatar
          user={profile ? { ...user, avatarUrl: profile.avatarUrl } : user}
          size={80}
          status={status}
        />
      </div>
      <div className="profile-body">
        <div className="profile-name">
          {nickname || user.displayName}
          {profile && profile.perks.length > 0 && (
            <PerkBadge perk={profile.perks[0] ?? 'animated_avatar'} locked={false} />
          )}
        </div>
        <div className="profile-sub">
          {nickname ? `${user.displayName} · ` : ''}
          {profile?.pronouns && <span>{profile.pronouns} · </span>}
          {LABELS[status]}
        </div>
        {profile && (profile.statusEmoji || profile.statusText) && (
          <div className="profile-custom-status">
            {profile.statusEmoji && <EmojiValue value={profile.statusEmoji} />}
            {profile.statusText && <span>{profile.statusText}</span>}
          </div>
        )}
        {profile?.bio && (
          <section className="profile-section">
            <h3>About me</h3>
            <div className="profile-bio">
              <Markdown
                content={profile.bio}
                nameOf={(id) => appStore.getState().users[id]?.displayName}
                meId={meId ?? ''}
              />
            </div>
          </section>
        )}
        {memberRoles.length > 0 && (
          <section className="profile-section">
            <h3>Roles</h3>
            <ul className="profile-roles">
              {memberRoles.map((role) => (
                <li
                  key={role.id}
                  className="role-chip role-colored"
                  style={roleColorStyle(role.color)}
                  data-role={role.color !== null || undefined}
                >
                  {role.name}
                </li>
              ))}
            </ul>
          </section>
        )}
        {data && (
          <section className="profile-section">
            <h3>Member since</h3>
            <p className="profile-dates">
              {data.member && <span>This server: {dateOf(data.member.joinedAt)}</span>}
              <span>Harmony: {dateOf(data.createdAt)}</span>
            </p>
          </section>
        )}
        {userId !== meId && !user.isBot && (
          <div className="profile-actions">
            <button className="button button-primary" onClick={() => void message()}>
              <ChatIcon width={18} height={18} /> Message
            </button>
            {guildId && access.has('manage_roles') && (
              <button
                className="button"
                onClick={() => {
                  close();
                  void navigate(`/settings/server/${guildId}/members`);
                }}
              >
                Manage roles
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProfilePopover({ userId, children }: { userId: string; children: ReactNode }) {
  const known = useApp((state) => state.users[userId] !== undefined);
  const guildId = useApp((state) => {
    const channelId = state.activeChannelId;
    return channelId ? (state.channels[channelId]?.guildId ?? null) : null;
  });
  const desktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  if (!known) return <>{children}</>;

  const card = <ProfileCard userId={userId} guildId={guildId} close={() => setOpen(false)} />;
  if (!desktop) {
    return (
      <>
        <span className="profile-trigger" onClick={() => setOpen(true)} role="presentation">
          {children}
        </span>
        <Modal open={open} onOpenChange={setOpen} title="Profile" variant="sheet">
          {card}
        </Modal>
      </>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover profile" sideOffset={8} collisionPadding={12}>
          {card}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
