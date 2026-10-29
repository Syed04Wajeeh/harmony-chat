import type { UserStatus } from '@harmony/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { changeStatus } from '../store/actions.js';
import { useApp } from '../store/store.js';
import { Avatar, StatusDot } from './Avatar.js';
import { SettingsIcon } from './Icons.js';
import { ownShownStatus } from '../lib/presence.js';
import { useProfiles } from '../store/profiles.js';
import { EmojiValue } from './Emoji.js';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './Menu.js';
import { StatusDialog, clearCustomStatus, setCustomStatus } from './StatusDialog.js';

const QUICK_STATUSES = [
  { emoji: '📅', text: 'In a meeting', duration: '1h' },
  { emoji: '🚌', text: 'Commuting', duration: '30m' },
  { emoji: '🤒', text: 'Out sick', duration: 'today' },
  { emoji: '🌴', text: 'On vacation', duration: 'never' },
] as const;

const STATUSES: { value: UserStatus; label: string; hint?: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'idle', label: 'Idle' },
  { value: 'dnd', label: 'Do not disturb' },
  { value: 'invisible', label: 'Invisible', hint: 'Appear offline' },
];

export function UserPanel() {
  const me = useApp((state) => state.me);
  const live = useApp((state) => (state.me ? state.presence[state.me.id] : undefined));
  const summary = useProfiles((state) => (me ? state.summaries[me.id] : undefined));
  const [editing, setEditing] = useState(false);
  if (!me) return null;
  const custom = summary?.statusEmoji || summary?.statusText;
  const current = STATUSES.find((status) => status.value === me.status);
  const shown = ownShownStatus(me.status, live);

  return (
    <div className="user-panel" data-harmony="user-panel">
      <Menu>
        <MenuTrigger
          className="user-panel-button"
          aria-label={`Status: ${current?.label ?? ''}. Change status`}
        >
          <Avatar user={me} size={36} status={shown} />
          <span className="user-panel-text">
            <span className="user-panel-name">{me.displayName}</span>
            <span className="user-panel-status">
              {custom ? (
                <>
                  {summary?.statusEmoji && <EmojiValue value={summary.statusEmoji} />}{' '}
                  {summary?.statusText}
                </>
              ) : (
                current?.label
              )}
            </span>
          </span>
        </MenuTrigger>
        <MenuContent side="top" align="start">
          {STATUSES.map((status) => (
            <MenuItem
              key={status.value}
              icon={<StatusDot status={status.value === 'invisible' ? 'offline' : status.value} />}
              checked={status.value === me.status}
              onSelect={() => void changeStatus(status.value)}
            >
              {status.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => setEditing(true)}>Set a custom status</MenuItem>
          {QUICK_STATUSES.map((quick) => (
            <MenuItem
              key={quick.text}
              icon={<span aria-hidden="true">{quick.emoji}</span>}
              onSelect={() => void setCustomStatus(quick.emoji, quick.text, quick.duration)}
            >
              {quick.text}
            </MenuItem>
          ))}
          {custom && <MenuItem onSelect={() => void clearCustomStatus()}>Clear status</MenuItem>}
        </MenuContent>
      </Menu>
      {editing && <StatusDialog open={editing} onOpenChange={setEditing} />}
      <Link to="/settings/user" className="icon-button" aria-label="User settings">
        <SettingsIcon />
      </Link>
    </div>
  );
}
