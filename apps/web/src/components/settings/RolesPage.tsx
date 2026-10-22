import type { GuildModule, Role } from '@harmony/shared';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../../api/client.js';
import { useGuildAccess } from '../../hooks/usePermission.js';
import { permissionGroups, permissionLabel } from '../../lib/permissions.js';
import { ROLE_PALETTE, parseHex, toHex } from '../../lib/roleColor.js';
import { attempt, loadGuildMembers, loadGuildModules, loadRoles } from '../../store/actions.js';
import { useApp } from '../../store/store.js';
import { Avatar } from '../Avatar.js';
import { ChevronDownIcon, PlusIcon } from '../Icons.js';
import { ConfirmDialog } from '../Overlay.js';
import { RoleDot } from '../RoleDot.js';
import { SettingsPage } from './SettingsLayout.js';

type Access = ReturnType<typeof useGuildAccess>;

function ColorPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (c: number | null) => void;
}) {
  const [custom, setCustom] = useState(value === null ? '' : toHex(value));
  return (
    <div className="role-colors">
      <div className="role-swatches" role="radiogroup" aria-label="Role color">
        <button
          type="button"
          className="role-swatch role-swatch-none"
          role="radio"
          aria-checked={value === null}
          aria-label="No color"
          onClick={() => {
            setCustom('');
            onChange(null);
          }}
        />
        {ROLE_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            className="role-swatch"
            role="radio"
            aria-checked={value === color}
            aria-label={toHex(color)}
            style={{ backgroundColor: toHex(color) }}
            onClick={() => {
              setCustom(toHex(color));
              onChange(color);
            }}
          />
        ))}
      </div>
      <label className="field role-custom">
        <span>Custom color</span>
        <input
          value={custom}
          placeholder="#539bf5"
          maxLength={7}
          aria-invalid={custom !== '' && parseHex(custom) === null}
          onChange={(event) => {
            setCustom(event.target.value);
            const parsed = parseHex(event.target.value);
            if (parsed !== null) onChange(parsed);
          }}
        />
      </label>
    </div>
  );
}

function PermissionToggles({
  modules,
  held,
  onToggle,
  access,
  disabled,
}: {
  modules: readonly GuildModule[];
  held: ReadonlySet<string>;
  onToggle: (key: string, on: boolean) => void;
  access: Access;
  disabled: boolean;
}) {
  return (
    <>
      {permissionGroups(modules).map((group) => (
        <fieldset key={group.title} className="permission-group">
          <legend>{group.title}</legend>
          {group.items.map((item) => {
            const on = held.has(item.key);
            // You can take a permission away, but only hand out what you hold yourself.
            const locked = disabled || (!on && !access.has(item.key));
            return (
              <label key={item.key} className="switch-row" data-locked={locked || undefined}>
                <span>
                  <strong>{permissionLabel(item.key)}</strong>
                  <small>{item.description}</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={permissionLabel(item.key)}
                  checked={on}
                  disabled={locked}
                  onChange={(event) => onToggle(item.key, event.target.checked)}
                />
              </label>
            );
          })}
        </fieldset>
      ))}
    </>
  );
}

function RoleMembers({
  guildId,
  role,
  editable,
}: {
  guildId: string;
  role: Role;
  editable: boolean;
}) {
  const members = useApp((state) => state.guildMembers[guildId]) ?? [];
  const info = useApp((state) => state.memberInfo[guildId]);
  const users = useApp((state) => state.users);
  const [query, setQuery] = useState('');
  const shown = members.filter((id) =>
    (info?.[id]?.nickname || users[id]?.displayName || '')
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="role-members">
      <label className="field">
        <span>Search members</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <ul className="picker-list">
        {shown.map((id) => {
          const user = users[id];
          if (!user) return null;
          const has = info?.[id]?.roleIds.includes(role.id) ?? false;
          return (
            <li key={id}>
              <Avatar user={user} size={32} />
              <span className="picker-name">{info?.[id]?.nickname || user.displayName}</span>
              <button
                className="button"
                disabled={!editable}
                onClick={() =>
                  void attempt(
                    has
                      ? api.revokeRole(guildId, id, role.id)
                      : api.assignRole(guildId, id, role.id),
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
    </div>
  );
}

function RoleEditor({
  guildId,
  role,
  access,
  modules,
  onDeleted,
}: {
  guildId: string;
  role: Role;
  access: Access;
  modules: readonly GuildModule[];
  onDeleted: () => void;
}) {
  const [tab, setTab] = useState<'display' | 'permissions' | 'members'>('display');
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color);
  const [hoist, setHoist] = useState(role.hoist);
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [held, setHeld] = useState(() => new Set(role.permissions));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  // Only @everyone's permissions can change, and only above-you roles are off limits.
  const editable = access.superuser || role.isDefault || role.position < access.top;
  const dirty =
    name !== role.name ||
    color !== role.color ||
    hoist !== role.hoist ||
    mentionable !== role.mentionable ||
    held.size !== role.permissions.length ||
    role.permissions.some((key) => !held.has(key));

  async function save() {
    setBusy(true);
    await attempt(
      api.updateRole(guildId, role.id, {
        ...(!role.isDefault && { name, color, hoist, mentionable }),
        permissions: [...held],
      }),
      'Could not save the role',
    );
    await loadRoles(guildId);
    setBusy(false);
  }

  return (
    <section className="role-editor" aria-label={`Edit ${role.name}`}>
      <header className="role-editor-header">
        <RoleDot color={color} />
        <h2>{role.isDefault ? '@everyone' : name || 'Role'}</h2>
      </header>
      {!editable && (
        <p className="settings-card-description">
          This role is above your highest role, so you can look but not change it.
        </p>
      )}
      <div className="role-tabs" role="tablist">
        {(role.isDefault
          ? (['permissions', 'members'] as const)
          : (['display', 'permissions', 'members'] as const)
        ).map((id) => (
          <button
            key={id}
            role="tab"
            className="chip"
            aria-selected={(role.isDefault ? 'permissions' : tab) === id}
            data-active={(role.isDefault ? 'permissions' : tab) === id || undefined}
            onClick={() => setTab(id)}
          >
            {id === 'display' ? 'Display' : id === 'permissions' ? 'Permissions' : 'Members'}
          </button>
        ))}
      </div>

      {tab === 'display' && !role.isDefault && (
        <div className="role-pane">
          <label className="field">
            <span>Role name</span>
            <input
              value={name}
              maxLength={100}
              disabled={!editable}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <ColorPicker value={color} onChange={(c) => editable && setColor(c)} />
          <label className="switch-row">
            <span>
              <strong>Show members separately</strong>
              <small>Group online members with this role in the member list.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={hoist}
              disabled={!editable}
              onChange={(e) => setHoist(e.target.checked)}
              aria-label="Show members separately"
            />
          </label>
          <label className="switch-row">
            <span>
              <strong>Mentionable</strong>
              <small>Let anyone mention this role.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={mentionable}
              disabled={!editable}
              onChange={(e) => setMentionable(e.target.checked)}
              aria-label="Mentionable"
            />
          </label>
        </div>
      )}
      {(tab === 'permissions' || role.isDefault) && tab !== 'members' && (
        <div className="role-pane">
          <PermissionToggles
            modules={modules}
            held={held}
            access={access}
            disabled={!editable}
            onToggle={(key, on) =>
              setHeld((current) => {
                const next = new Set(current);
                if (on) next.add(key);
                else next.delete(key);
                return next;
              })
            }
          />
        </div>
      )}
      {tab === 'members' && !role.isDefault && (
        <RoleMembers guildId={guildId} role={role} editable={editable} />
      )}
      {tab === 'members' && role.isDefault && (
        <p className="settings-card-description">Everyone in the server has @everyone.</p>
      )}

      {tab !== 'members' && (
        <div className="role-actions">
          {!role.isDefault && (
            <button
              className="button button-danger-outline"
              disabled={!editable}
              onClick={() => setConfirm(true)}
            >
              Delete role
            </button>
          )}
          <button
            className="button button-primary"
            disabled={!dirty || busy || !editable || !name.trim()}
            onClick={() => void save()}
          >
            Save changes
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${role.name}?`}
        description="Members lose this role and what it granted."
        confirmLabel="Delete role"
        danger
        onConfirm={() => {
          void attempt(api.deleteRole(guildId, role.id), 'Could not delete the role').then(() => {
            void loadRoles(guildId);
            onDeleted();
          });
        }}
      />
    </section>
  );
}

export function RolesPage() {
  const { guildId = '' } = useParams();
  const roles = useApp((state) => state.roles[guildId]);
  const modules = useApp((state) => state.guildModules[guildId]);
  const info = useApp((state) => state.memberInfo[guildId]);
  const access = useGuildAccess(guildId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => {
    void loadRoles(guildId);
    void loadGuildMembers(guildId);
    if (!modules) void loadGuildModules(guildId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId]);

  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const entry of Object.values(info ?? {})) {
      for (const id of entry.roleIds) result.set(id, (result.get(id) ?? 0) + 1);
    }
    return result;
  }, [info]);

  const list = roles ?? [];
  const movable = list.filter((role) => !role.isDefault);
  const selected = list.find((role) => role.id === selectedId) ?? null;
  const canMove = (role: Role) => access.superuser || role.position < access.top;

  async function reorder(ids: string[]) {
    await attempt(api.reorderRoles(guildId, ids), 'Could not reorder roles');
    await loadRoles(guildId);
  }
  const move = (role: Role, delta: -1 | 1) => {
    const ids = movable.map((r) => r.id);
    const from = ids.indexOf(role.id);
    const to = from + delta;
    const swap = movable[to];
    if (!swap || (delta === -1 && !(access.superuser || role.position + 1 < access.top))) return;
    ids.splice(from, 1);
    ids.splice(to, 0, role.id);
    void reorder(ids);
  };
  const drop = (target: Role) => {
    if (!dragging || dragging === target.id) return;
    const ids = movable.map((r) => r.id).filter((id) => id !== dragging);
    ids.splice(ids.indexOf(target.id), 0, dragging);
    setDragging(null);
    void reorder(ids);
  };

  async function create() {
    const role = await attempt(
      api.createRole(guildId, { name: 'New role' }),
      'Could not create the role',
    );
    await loadRoles(guildId);
    if (role) setSelectedId(role.id);
  }

  return (
    <SettingsPage
      title="Roles"
      back={selected ? () => setSelectedId(null) : `/settings/server/${guildId}`}
    >
      <div className="roles-layout" data-editing={selected ? '' : undefined}>
        <aside className="role-list" aria-label="Roles">
          <button
            className="button button-primary"
            disabled={!access.has('manage_roles')}
            onClick={() => void create()}
          >
            <PlusIcon width={16} height={16} /> Create role
          </button>
          <ul>
            {list.map((role) => (
              <li
                key={role.id}
                draggable={!role.isDefault && canMove(role)}
                data-selected={selectedId === role.id || undefined}
                data-dragging={dragging === role.id || undefined}
                onDragStart={() => setDragging(role.id)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => dragging && event.preventDefault()}
                onDrop={() => drop(role)}
              >
                <button className="role-row" onClick={() => setSelectedId(role.id)}>
                  <RoleDot color={role.color} />
                  <span className="role-row-name">{role.isDefault ? '@everyone' : role.name}</span>
                  <small>{role.isDefault ? 'All members' : String(counts.get(role.id) ?? 0)}</small>
                </button>
                {!role.isDefault && (
                  <span className="role-move">
                    <button
                      className="icon-button icon-button-small"
                      aria-label={`Move ${role.name} up`}
                      disabled={!canMove(role) || role.id === movable[0]?.id}
                      onClick={() => move(role, -1)}
                    >
                      <ChevronDownIcon width={16} height={16} style={{ rotate: '180deg' }} />
                    </button>
                    <button
                      className="icon-button icon-button-small"
                      aria-label={`Move ${role.name} down`}
                      disabled={!canMove(role) || role.id === movable.at(-1)?.id}
                      onClick={() => move(role, 1)}
                    >
                      <ChevronDownIcon width={16} height={16} />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </aside>
        {selected ? (
          <RoleEditor
            key={selected.id}
            guildId={guildId}
            role={selected}
            access={access}
            modules={modules ?? []}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <p className="role-empty settings-card-description">
            Pick a role to edit what it looks like, what it allows and who has it.
          </p>
        )}
      </div>
    </SettingsPage>
  );
}
