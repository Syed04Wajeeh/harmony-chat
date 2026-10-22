import type { UserStatus } from '@harmony/shared';
import { Link } from 'react-router';
import { changeStatus } from '../store/actions.js';
import { useApp } from '../store/store.js';
import { Avatar, StatusDot } from './Avatar.js';
import { SettingsIcon } from './Icons.js';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './Menu.js';

const STATUSES: { value: UserStatus; label: string; hint?: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'idle', label: 'Idle' },
  { value: 'dnd', label: 'Do not disturb' },
  { value: 'invisible', label: 'Invisible', hint: 'Appear offline' },
];

export function UserPanel() {
  const me = useApp((state) => state.me);
  if (!me) return null;
  const current = STATUSES.find((status) => status.value === me.status);

  return (
    <div className="user-panel" data-harmony="user-panel">
      <Menu>
        <MenuTrigger
          className="user-panel-button"
          aria-label={`Status: ${current?.label ?? ''}. Change status`}
        >
          <Avatar user={me} size={36} status={me.status === 'dnd' ? 'dnd' : me.status} />
          <span className="user-panel-text">
            <span className="user-panel-name">{me.displayName}</span>
            <span className="user-panel-status">{current?.label}</span>
          </span>
        </MenuTrigger>
        <MenuContent side="top" align="start">
          {STATUSES.map((status) => (
            <MenuItem
              key={status.value}
              icon={<StatusDot status={status.value === 'invisible' ? 'offline' : status.value} />}
              onSelect={() => void changeStatus(status.value)}
            >
              {status.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <Link to="/settings/user" className="icon-button" aria-label="User settings">
        <SettingsIcon />
      </Link>
    </div>
  );
}
