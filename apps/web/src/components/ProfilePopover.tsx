import * as Popover from '@radix-ui/react-popover';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { channelPath } from '../lib/paths.js';
import { openDm } from '../store/actions.js';
import { useApp } from '../store/store.js';
import { useUi } from '../store/ui.js';
import { Avatar } from './Avatar.js';
import { ChatIcon } from './Icons.js';

const LABELS = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Offline',
} as const;

export function usePresenceOf(userId: string) {
  return useApp((state) =>
    state.me?.id === userId
      ? state.me.status === 'invisible'
        ? 'offline'
        : state.me.status
      : (state.presence[userId] ?? 'offline'),
  );
}

export function ProfilePopover({ userId, children }: { userId: string; children: ReactNode }) {
  const user = useApp((state) => state.users[userId]);
  const meId = useApp((state) => state.me?.id);
  const status = usePresenceOf(userId);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  if (!user) return <>{children}</>;

  async function message() {
    const dm = await openDm(userId);
    if (!dm) return;
    setOpen(false);
    useUi.getState().setDrawer(null);
    void navigate(channelPath(dm));
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover profile" sideOffset={8} collisionPadding={12}>
          <Avatar user={user} size={64} status={status} />
          <div className="profile-name">{user.displayName}</div>
          <div className="profile-status">{LABELS[status]}</div>
          {userId !== meId && !user.isBot && (
            <button className="button button-primary" onClick={() => void message()}>
              <ChatIcon width={18} height={18} /> Message
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
