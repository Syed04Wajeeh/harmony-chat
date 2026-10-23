import { MAX_STATUS_TEXT_LENGTH, STATUS_DURATIONS, type StatusDuration } from '@harmony/shared';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client.js';
import { attempt } from '../store/actions.js';
import { useProfiles } from '../store/profiles.js';
import { useApp } from '../store/store.js';
import { EmojiPickerButton } from './EmojiPicker.js';
import { EmojiValue } from './Emoji.js';
import { Modal } from './Overlay.js';
import { PerkBadge } from './PerkBadge.js';

export const DURATION_LABELS: Record<StatusDuration, string> = {
  '30m': '30 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  today: 'Today',
  never: "Don't clear",
};

export async function setCustomStatus(
  emoji: string | null,
  text: string | null,
  duration: StatusDuration,
) {
  await attempt(
    api.updateProfile({
      status: { emoji, text, duration, tzOffsetMinutes: new Date().getTimezoneOffset() },
    }),
    'Could not set your status',
  );
}

export const clearCustomStatus = () => attempt(api.updateProfile({ status: null }));

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function StatusDialog({ open, onOpenChange }: Props) {
  const meId = useApp((state) => state.me?.id ?? '');
  const current = useProfiles((state) => state.summaries[meId]);
  const canCustom = useProfiles((state) => state.perks.has('custom_status_emoji'));
  const [emoji, setEmoji] = useState<string | null>(current?.statusEmoji ?? null);
  const [text, setText] = useState(current?.statusText ?? '');
  const [duration, setDuration] = useState<StatusDuration>('1h');

  async function submit(event: FormEvent) {
    event.preventDefault();
    await setCustomStatus(emoji, text.trim() || null, duration);
    onOpenChange(false);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Set a custom status">
      <form className="form" onSubmit={(event) => void submit(event)}>
        <div className="status-input">
          <EmojiPickerButton label="Pick a status emoji" className="icon-button" onPick={setEmoji}>
            {emoji ? <EmojiValue value={emoji} /> : '🙂'}
          </EmojiPickerButton>
          <input
            autoFocus
            aria-label="Status text"
            maxLength={MAX_STATUS_TEXT_LENGTH}
            placeholder="What's happening?"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        {!canCustom && (
          <p className="field-hint">
            Custom server emoji in a status <PerkBadge perk="custom_status_emoji" />
          </p>
        )}
        <label className="field">
          <span>Clear after</span>
          <select value={duration} onChange={(e) => setDuration(e.target.value as StatusDuration)}>
            {STATUS_DURATIONS.map((value) => (
              <option key={value} value={value}>
                {DURATION_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            onClick={() => {
              void clearCustomStatus();
              onOpenChange(false);
            }}
          >
            Clear status
          </button>
          <button className="button button-primary" disabled={!emoji && !text.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
