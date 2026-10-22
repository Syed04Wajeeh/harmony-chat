import { MAX_TOPIC_LENGTH } from '@harmony/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client.js';
import { channelPath } from '../../lib/paths.js';
import { attempt } from '../../store/actions.js';
import { appStore } from '../../store/store.js';
import { Modal } from '../Overlay.js';

interface Props {
  guildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32);

export function CreateChannelDialog({ guildId, open, onOpenChange }: Props) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const channel = await attempt(
      api.createChannel(guildId, { name, isPrivate, ...(topic.trim() && { topic: topic.trim() }) }),
      'Could not create the channel',
    );
    if (channel) {
      appStore.getState().upsertChannel(channel);
      onOpenChange(false);
      setName('');
      setTopic('');
      setPrivate(false);
      void navigate(channelPath(channel));
    }
    setBusy(false);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Create a channel">
      <form onSubmit={(event) => void submit(event)} className="form">
        <label className="field">
          <span>Channel name</span>
          <input
            autoFocus
            required
            value={name}
            onChange={(event) => setName(slug(event.target.value))}
            placeholder="new-channel"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </label>
        <label className="field">
          <span>Topic (optional)</span>
          <input
            value={topic}
            maxLength={MAX_TOPIC_LENGTH}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="What is this channel for?"
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>Private channel</strong>
            <small>Only people you add can read it.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={isPrivate}
            onChange={(event) => setPrivate(event.target.checked)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button className="button button-primary" disabled={busy || !name}>
            Create channel
          </button>
        </div>
      </form>
    </Modal>
  );
}
