import { type ChannelOverwrite, type ChannelSummary } from '@harmony/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { permissionGroups, permissionLabel } from '../../lib/permissions.js';
import {
  attempt,
  loadGuildMembers,
  loadGuildModules,
  loadOverwrites,
  loadRoles,
} from '../../store/actions.js';
import { appStore, useApp } from '../../store/store.js';
import { Modal } from '../Overlay.js';
import { RoleDot } from '../RoleDot.js';

type State = 'allow' | 'neutral' | 'deny';

const NEXT_LABEL: Record<State, string> = { deny: 'Deny', neutral: 'Inherit', allow: 'Allow' };

function stateOf(overwrite: ChannelOverwrite | undefined, key: string): State {
  if (overwrite?.allow.includes(key)) return 'allow';
  if (overwrite?.deny.includes(key)) return 'deny';
  return 'neutral';
}

function PermissionsTab({ channel }: { channel: ChannelSummary }) {
  const guildId = channel.guildId ?? '';
  const roles = useApp((state) => state.roles[guildId]) ?? [];
  const modules = useApp((state) => state.guildModules[guildId]) ?? [];
  const overwrites = useApp((state) => state.overwrites[channel.id]) ?? [];
  const members = useApp((state) => state.guildMembers[guildId]) ?? [];
  const users = useApp((state) => state.users);
  const [target, setTarget] = useState<{ type: 'role' | 'member'; id: string } | null>(null);

  useEffect(() => {
    void loadOverwrites(channel.id);
    void loadRoles(guildId);
    void loadGuildMembers(guildId);
    void loadGuildModules(guildId);
  }, [channel.id, guildId]);

  const everyone = roles.find((role) => role.isDefault);
  const current = target ?? (everyone ? { type: 'role' as const, id: everyone.id } : null);
  const overwrite = overwrites.find(
    (o) => o.targetType === current?.type && o.targetId === current.id,
  );
  const label = (type: 'role' | 'member', id: string) =>
    type === 'role'
      ? roles.find((r) => r.id === id)?.isDefault
        ? '@everyone'
        : (roles.find((r) => r.id === id)?.name ?? 'Role')
      : (users[id]?.displayName ?? 'Member');

  async function set(key: string, next: State) {
    if (!current) return;
    const allow = (overwrite?.allow ?? []).filter((k) => k !== key);
    const deny = (overwrite?.deny ?? []).filter((k) => k !== key);
    if (next === 'allow') allow.push(key);
    if (next === 'deny') deny.push(key);
    const updated = await attempt(
      api.putOverwrite(channel.id, current.type, current.id, { allow, deny }),
      'Could not change permissions',
    );
    if (updated) appStore.getState().setOverwrites(channel.id, updated);
  }

  const known = new Set(overwrites.map((o) => `${o.targetType}:${o.targetId}`));
  const addable = [
    ...roles.map((r) => ({ type: 'role' as const, id: r.id })),
    ...members.map((id) => ({ type: 'member' as const, id })),
  ].filter((t) => !known.has(`${t.type}:${t.id}`) && !(t.type === 'role' && t.id === everyone?.id));
  const rows = [
    ...(everyone ? [{ type: 'role' as const, id: everyone.id }] : []),
    ...overwrites
      .filter((o) => !(o.targetType === 'role' && o.targetId === everyone?.id))
      .map((o) => ({ type: o.targetType, id: o.targetId })),
  ];

  return (
    <div className="overwrites">
      <div className="overwrite-targets" role="tablist" aria-label="Roles and members">
        {rows.map((row) => (
          <button
            key={`${row.type}:${row.id}`}
            role="tab"
            className="chip"
            aria-selected={current?.type === row.type && current.id === row.id}
            data-active={(current?.type === row.type && current.id === row.id) || undefined}
            onClick={() => setTarget(row)}
          >
            {row.type === 'role' && (
              <RoleDot color={roles.find((r) => r.id === row.id)?.color ?? null} />
            )}{' '}
            {label(row.type, row.id)}
          </button>
        ))}
        <select
          aria-label="Add a role or member"
          value=""
          onChange={(event) => {
            const [type, id] = event.target.value.split(':');
            if (type && id) setTarget({ type: type as 'role' | 'member', id });
          }}
        >
          <option value="">Add role or member…</option>
          {addable.map((t) => (
            <option key={`${t.type}:${t.id}`} value={`${t.type}:${t.id}`}>
              {t.type === 'role' ? 'Role' : 'Member'}: {label(t.type, t.id)}
            </option>
          ))}
        </select>
      </div>
      {permissionGroups(modules, { channelOnly: true }).map((group) => (
        <fieldset key={group.title} className="permission-group">
          <legend>{group.title}</legend>
          {group.items.map((item) => {
            const value = stateOf(overwrite, item.key);
            return (
              <div key={item.key} className="overwrite-row">
                <span>
                  <strong>{permissionLabel(item.key)}</strong>
                  <small>{item.description}</small>
                </span>
                <span
                  className="tri-state"
                  role="radiogroup"
                  aria-label={permissionLabel(item.key)}
                >
                  {(['deny', 'neutral', 'allow'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={value === option}
                      aria-label={`${NEXT_LABEL[option]} ${permissionLabel(item.key)}`}
                      data-state={option}
                      onClick={() => void set(item.key, option)}
                    >
                      {option === 'deny' ? '✕' : option === 'allow' ? '✓' : '/'}
                    </button>
                  ))}
                </span>
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

function OverviewTab({ channel, onDone }: { channel: ChannelSummary; onDone: () => void }) {
  const [name, setName] = useState(channel.name ?? '');
  const [topic, setTopic] = useState(channel.topic ?? '');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void attempt(
          api.updateChannel(channel.id, { name, topic }),
          'Could not save the channel',
        ).then(onDone);
      }}
    >
      <label className="field">
        <span>Channel name</span>
        <input
          value={name}
          maxLength={32}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
        />
      </label>
      <label className="field">
        <span>Topic</span>
        <input value={topic} maxLength={256} onChange={(e) => setTopic(e.target.value)} />
      </label>
      <div className="modal-actions">
        <button className="button button-primary" disabled={!name}>
          Save
        </button>
      </div>
    </form>
  );
}

export function ChannelSettingsDialog({
  channel,
  open,
  onOpenChange,
  canEdit,
  canPermissions,
}: {
  channel: ChannelSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  canPermissions: boolean;
}) {
  const [tab, setTab] = useState<'overview' | 'permissions'>(canEdit ? 'overview' : 'permissions');
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`#${channel.name ?? ''} settings`}>
      <div className="role-tabs" role="tablist">
        {canEdit && (
          <button
            role="tab"
            className="chip"
            aria-selected={tab === 'overview'}
            data-active={tab === 'overview' || undefined}
            onClick={() => setTab('overview')}
          >
            Overview
          </button>
        )}
        {canPermissions && (
          <button
            role="tab"
            className="chip"
            aria-selected={tab === 'permissions'}
            data-active={tab === 'permissions' || undefined}
            onClick={() => setTab('permissions')}
          >
            Permissions
          </button>
        )}
      </div>
      {tab === 'overview' && canEdit && (
        <OverviewTab channel={channel} onDone={() => onOpenChange(false)} />
      )}
      {tab === 'permissions' && canPermissions && <PermissionsTab channel={channel} />}
    </Modal>
  );
}
