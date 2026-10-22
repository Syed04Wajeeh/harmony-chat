import { MAX_GUILD_NAME_LENGTH, type GuildSummary } from '@harmony/shared';
import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, uploadFile } from '../../api/client.js';
import { attempt } from '../../store/actions.js';
import { appStore } from '../../store/store.js';
import { GuildIcon } from '../Avatar.js';
import { ConfirmDialog, Modal } from '../Overlay.js';

interface Props {
  guild: GuildSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GuildSettingsDialog({ guild, open, onOpenChange }: Props) {
  const [name, setName] = useState(guild.name);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  async function update(body: Parameters<typeof api.updateGuild>[1]) {
    setBusy(true);
    const updated = await attempt(api.updateGuild(guild.id, body), 'Could not save changes');
    if (updated) appStore.getState().upsertGuild(updated);
    setBusy(false);
    return updated;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (await update({ name: name.trim() })) onOpenChange(false);
  }

  async function chooseIcon(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    const attachment = await attempt(uploadFile(file), 'Could not upload the icon');
    setBusy(false);
    if (attachment) await update({ iconAttachmentId: attachment.id });
  }

  async function remove() {
    const result = await attempt(
      api.deleteGuild(guild.id).then(() => true),
      'Could not delete',
    );
    if (result) {
      onOpenChange(false);
      void navigate('/');
    }
  }

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange} title="Server settings">
        <form onSubmit={(event) => void save(event)} className="form">
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
          <div className="modal-actions modal-actions-split">
            <button
              type="button"
              className="button button-danger-outline"
              onClick={() => setConfirmDelete(true)}
            >
              Delete server
            </button>
            <button
              className="button button-primary"
              disabled={busy || !name.trim() || name.trim() === guild.name}
            >
              Save
            </button>
          </div>
        </form>
      </Modal>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${guild.name}?`}
        description="All channels and messages in this server will be permanently deleted for everyone."
        confirmLabel="Delete server"
        danger
        onConfirm={() => void remove()}
      />
    </>
  );
}
