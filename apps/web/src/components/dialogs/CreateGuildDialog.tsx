import { MAX_GUILD_NAME_LENGTH } from '@harmony/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client.js';
import { attempt } from '../../store/actions.js';
import { appStore } from '../../store/store.js';
import { guildPath } from '../../lib/paths.js';
import { Modal } from '../Overlay.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateGuildDialog({ open, onOpenChange }: Props) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const guild = await attempt(api.createGuild(name.trim()), 'Could not create the server');
    if (guild) {
      const store = appStore.getState();
      store.upsertGuild(guild);
      const channels = await attempt(api.guildChannels(guild.id));
      for (const channel of channels ?? []) store.upsertChannel(channel);
      onOpenChange(false);
      setName('');
      void navigate(guildPath(guild.id, Object.values(appStore.getState().channels)));
    }
    setBusy(false);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create a server"
      description="A server is a place for your people and their channels. You can invite others with a link."
    >
      <form onSubmit={(event) => void submit(event)} className="form">
        <label className="field">
          <span>Server name</span>
          <input
            autoFocus
            required
            maxLength={MAX_GUILD_NAME_LENGTH}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Book club"
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button className="button button-primary" disabled={busy || !name.trim()}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
