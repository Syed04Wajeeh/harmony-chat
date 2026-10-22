import type { Role } from '@harmony/shared';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../../api/client.js';
import { useGuildAccess } from '../../hooks/usePermission.js';
import { roleColorStyle } from '../../lib/roleColor.js';
import { attempt, loadGuildMembers, loadRoles } from '../../store/actions.js';
import { useApp } from '../../store/store.js';
import { Avatar } from '../Avatar.js';
import { ConfirmDialog, Modal } from '../Overlay.js';
import { RoleDot } from '../RoleDot.js';
import { SettingsPage } from './SettingsLayout.js';

type Dialog = { kind: 'nickname' | 'roles' | 'kick'; userId: string } | null;

export function MembersPage() {
  const { guildId = '' } = useParams();
  const guild = useApp((state) => state.guilds[guildId]);
  const members = useApp((state) => state.guildMembers[guildId]) ?? [];
  const info = useApp((state) => state.memberInfo[guildId]);
  const roles = useApp((state) => state.roles[guildId]) ?? [];
  const users = useApp((state) => state.users);
  const meId = useApp((state) => state.me?.id);
  const access = useGuildAccess(guildId);
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [nickname, setNickname] = useState('');

  useEffect(() => {
    void loadGuildMembers(guildId);
    void loadRoles(guildId);
  }, [guildId]);

  const roleOf = (id: string): Role | undefined => roles.find((role) => role.id === id);
  const topOf = (userId: string) =>
    Math.max(0, ...(info?.[userId]?.roleIds ?? []).map((id) => roleOf(id)?.position ?? 0));
  const outranked = (userId: string) =>
    userId !== guild?.ownerId && (access.superuser || access.top > topOf(userId));

  const shown = members
    .filter((id) => users[id])
    .filter((id) =>
      (info?.[id]?.nickname || users[id]?.displayName || '')
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  const target = dialog ? users[dialog.userId] : undefined;

  return (
    <SettingsPage title="Members" back={`/settings/server/${guildId}`}>
      <label className="field">
        <span>Search members</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name or nickname"
        />
      </label>
      <ul className="settings-list member-admin-list">
        {shown.map((id) => {
          const user = users[id];
          if (!user) return null;
          const held = (info?.[id]?.roleIds ?? [])
            .map(roleOf)
            .filter((role): role is Role => role !== undefined)
            .sort((a, b) => b.position - a.position);
          const colored = held.find((role) => role.color !== null);
          const mine = id === meId;
          return (
            <li key={id} className="settings-row member-admin-row">
              <Avatar user={user} size={40} />
              <span className="settings-row-text">
                <span
                  className="settings-row-title"
                  data-role={colored ? '' : undefined}
                  style={roleColorStyle(colored?.color)}
                >
                  {info?.[id]?.nickname || user.displayName}
                </span>
                <span className="settings-row-meta">
                  {info?.[id]?.nickname ? `${user.displayName} · ` : ''}
                  {id === guild?.ownerId ? 'Owner' : user.login}
                </span>
                {held.length > 0 && (
                  <span className="member-role-chips">
                    {held.map((role) => (
                      <span key={role.id} className="role-chip">
                        <RoleDot color={role.color} /> {role.name}
                      </span>
                    ))}
                  </span>
                )}
              </span>
              <span className="member-admin-actions">
                {(mine
                  ? access.has('change_nickname')
                  : access.has('manage_nicknames') && outranked(id)) && (
                  <button
                    className="button"
                    onClick={() => {
                      setNickname(info?.[id]?.nickname ?? '');
                      setDialog({ kind: 'nickname', userId: id });
                    }}
                  >
                    Nickname
                  </button>
                )}
                {access.has('manage_roles') && roles.some((r) => !r.isDefault) && (
                  <button
                    className="button"
                    onClick={() => setDialog({ kind: 'roles', userId: id })}
                  >
                    Roles
                  </button>
                )}
                {!mine && access.has('kick_members') && outranked(id) && (
                  <button
                    className="button button-danger-outline"
                    onClick={() => setDialog({ kind: 'kick', userId: id })}
                  >
                    Kick
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <Modal
        open={dialog?.kind === 'nickname'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Change nickname"
        description={`How ${target?.displayName ?? 'this member'} appears in ${guild?.name ?? 'this server'}.`}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!dialog) return;
            void attempt(
              api.setNickname(guildId, dialog.userId, nickname.trim() || null),
              'Could not change the nickname',
            );
            setDialog(null);
          }}
        >
          <label className="field">
            <span>Nickname</span>
            <input
              autoFocus
              maxLength={32}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={target?.displayName}
            />
          </label>
          <div className="modal-actions">
            <button className="button button-primary">Save</button>
          </div>
        </form>
      </Modal>

      <Modal
        open={dialog?.kind === 'roles'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Roles for ${target?.displayName ?? ''}`}
      >
        <ul className="picker-list">
          {roles
            .filter((role) => !role.isDefault)
            .map((role) => {
              const has = dialog
                ? (info?.[dialog.userId]?.roleIds.includes(role.id) ?? false)
                : false;
              const allowed = access.superuser || role.position < access.top;
              return (
                <li key={role.id}>
                  <RoleDot color={role.color} />
                  <span className="picker-name">{role.name}</span>
                  <button
                    className="button"
                    disabled={!allowed}
                    onClick={() =>
                      dialog &&
                      void attempt(
                        has
                          ? api.revokeRole(guildId, dialog.userId, role.id)
                          : api.assignRole(guildId, dialog.userId, role.id),
                        'Could not change roles',
                      )
                    }
                  >
                    {has ? 'Remove' : 'Add'}
                  </button>
                </li>
              );
            })}
        </ul>
      </Modal>

      <ConfirmDialog
        open={dialog?.kind === 'kick'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Kick ${target?.displayName ?? 'this member'}?`}
        description="They leave the server and can rejoin with an invite."
        confirmLabel="Kick"
        danger
        onConfirm={() => {
          if (dialog)
            void attempt(api.kickMember(guildId, dialog.userId), 'Could not kick that member');
        }}
      />
    </SettingsPage>
  );
}
