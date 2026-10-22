import { MAX_GUILD_NAME_LENGTH } from '@harmony/shared';
import { useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, uploadFile } from '../../api/client.js';
import { attempt } from '../../store/actions.js';
import { appStore, useApp } from '../../store/store.js';
import { GuildIcon } from '../Avatar.js';
import { ConfirmDialog } from '../Overlay.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

export function OverviewPage() {
  const { guildId = '' } = useParams();
  const guild = useApp((state) => state.guilds[guildId]);
  const meId = useApp((state) => state.me?.id);
  const picker = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [name, setName] = useState(guild?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!guild) return null;

  async function update(body: Parameters<typeof api.updateGuild>[1]) {
    setBusy(true);
    const updated = await attempt(api.updateGuild(guildId, body), 'Could not save changes');
    if (updated) appStore.getState().upsertGuild(updated);
    setBusy(false);
    return updated;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await update({ name: name.trim() });
  }

  async function chooseIcon(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    const attachment = await attempt(uploadFile(file), 'Could not upload the icon');
    setBusy(false);
    if (attachment) await update({ iconAttachmentId: attachment.id });
  }

  async function remove() {
    const deleted = await attempt(
      api.deleteGuild(guildId).then(() => true),
      'Could not delete',
    );
    if (deleted) void navigate('/');
  }

  return (
    <SettingsPage title="Overview" back={`/settings/server/${guildId}`}>
      <SettingsCard title="Server">
        <form className="form" onSubmit={(event) => void save(event)}>
          <div className="icon-editor">
            <GuildIcon guild={guild} size={72} />
            <div className="icon-editor-actions">
              <input
                ref={picker}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={(event) => {
                  void chooseIcon(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              <button type="button" className="button" onClick={() => picker.current?.click()}>
                Upload icon
              </button>
              {guild.iconUrl && (
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => void update({ iconAttachmentId: null })}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
          <label className="field">
            <span>Server name</span>
            <input
              required
              maxLength={MAX_GUILD_NAME_LENGTH}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button
              className="button button-primary"
              disabled={busy || !name.trim() || name.trim() === guild.name}
            >
              Save
            </button>
          </div>
        </form>
      </SettingsCard>
      {guild.ownerId === meId && (
        <SettingsCard
          title="Delete server"
          description="All channels and messages in this server are permanently deleted for everyone."
          danger
        >
          <button
            type="button"
            className="button button-danger-outline"
            onClick={() => setConfirmDelete(true)}
          >
            Delete server
          </button>
        </SettingsCard>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${guild.name}?`}
        description="All channels and messages in this server will be permanently deleted for everyone."
        confirmLabel="Delete server"
        danger
        onConfirm={() => void remove()}
      />
    </SettingsPage>
  );
}
