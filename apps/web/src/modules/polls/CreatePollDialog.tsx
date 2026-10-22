import {
  POLL_MAX_OPTIONS,
  POLL_MAX_OPTION_LENGTH,
  POLL_MAX_QUESTION_LENGTH,
  POLL_MIN_OPTIONS,
  PollSettings,
} from '@harmony/shared';
import { useState, type FormEvent } from 'react';
import { CloseIcon, PlusIcon } from '../../components/Icons.js';
import { Modal } from '../../components/Overlay.js';
import { attempt } from '../../store/actions.js';
import { appStore, useApp } from '../../store/store.js';
import type { DialogProps } from '../types.js';
import { pollsApi } from './api.js';

/** The guild's poll settings, or the defaults while they are not loaded (and in DMs). */
function useSettings(guildId: string | null): PollSettings {
  const stored = useApp((state) =>
    guildId ? state.guildModules[guildId]?.find((module) => module.id === 'polls') : undefined,
  );
  return PollSettings.parse(stored?.settings ?? {});
}

export function CreatePollDialog({ channelId, guildId, onClose }: DialogProps) {
  const settings = useSettings(guildId);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [busy, setBusy] = useState(false);

  const filled = options.map((label) => label.trim()).filter(Boolean);
  const valid =
    question.trim().length > 0 &&
    filled.length >= POLL_MIN_OPTIONS &&
    new Set(filled.map((label) => label.toLowerCase())).size === filled.length;

  const setOption = (index: number, label: string) =>
    setOptions((current) => current.map((value, i) => (i === index ? label : value)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const message = await attempt(
      pollsApi.create(channelId, {
        question: question.trim(),
        options: filled,
        multiple: multiple && settings.allowMultipleChoice,
      }),
      'Could not create the poll',
    );
    setBusy(false);
    if (message) {
      appStore.getState().applyFrame({ type: 'message.created', message });
      onClose();
    }
  }

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title="Create a poll">
      <form onSubmit={(event) => void submit(event)} className="form">
        <label className="field">
          <span>Question</span>
          <input
            autoFocus
            required
            value={question}
            maxLength={POLL_MAX_QUESTION_LENGTH}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What should we read next?"
          />
        </label>
        <fieldset className="poll-fields">
          <legend>Options</legend>
          {options.map((label, index) => (
            <div key={index} className="poll-field">
              <input
                value={label}
                maxLength={POLL_MAX_OPTION_LENGTH}
                aria-label={`Option ${String(index + 1)}`}
                placeholder={`Option ${String(index + 1)}`}
                onChange={(event) => setOption(index, event.target.value)}
              />
              {options.length > POLL_MIN_OPTIONS && (
                <button
                  type="button"
                  className="icon-button icon-button-small"
                  aria-label={`Remove option ${String(index + 1)}`}
                  onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}
                >
                  <CloseIcon width={16} height={16} />
                </button>
              )}
            </div>
          ))}
          {options.length < POLL_MAX_OPTIONS && (
            <button
              type="button"
              className="button poll-add"
              onClick={() => setOptions((c) => [...c, ''])}
            >
              <PlusIcon width={16} height={16} /> Add option
            </button>
          )}
        </fieldset>
        {settings.allowMultipleChoice && (
          <label className="switch-row">
            <span>
              <strong>Allow multiple answers</strong>
              <small>People can pick more than one option.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={multiple}
              onChange={(event) => setMultiple(event.target.checked)}
            />
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={!valid || busy}>
            Create poll
          </button>
        </div>
      </form>
    </Modal>
  );
}
