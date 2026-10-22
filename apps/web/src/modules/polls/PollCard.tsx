import type { Message, Poll } from '@harmony/shared';
import { useState } from 'react';
import { attempt } from '../../store/actions.js';
import { appStore, useApp } from '../../store/store.js';
import { pollsApi } from './api.js';
import { myVotes, nextVotes, percentOf } from './tally.js';

function setPoll(message: Message, poll: Poll): void {
  appStore.getState().patchMessage(message.channelId, message.id, (m) => ({
    ...m,
    modules: { ...m.modules, polls: poll },
  }));
}

/** The options of a poll as bars: counts, percentages, and the viewer's own votes highlighted. */
export function PollCard({ message, data: poll }: { message: Message; data: Poll }) {
  const meId = useApp((state) => state.me?.id ?? '');
  const [busy, setBusy] = useState(false);
  const mine = myVotes(poll, meId);
  const isAuthor = message.author.id === meId;

  async function vote(optionId: number) {
    if (busy || poll.closed) return;
    setBusy(true);
    const updated = await attempt(
      pollsApi.vote(message.id, nextVotes(poll, mine, optionId)),
      'Could not record your vote',
    );
    if (updated) setPoll(message, updated);
    setBusy(false);
  }

  async function close() {
    setBusy(true);
    const updated = await attempt(pollsApi.close(message.id), 'Could not close the poll');
    if (updated) setPoll(message, updated);
    setBusy(false);
  }

  const kind = poll.multiple ? 'Choose any' : 'Choose one';
  return (
    <div className="poll" data-closed={poll.closed || undefined} role="group" aria-label="Poll">
      <ul className="poll-options">
        {poll.options.map((option) => {
          const percent = percentOf(option, poll);
          const chosen = mine.includes(option.id);
          return (
            <li key={option.id}>
              <button
                type="button"
                className="poll-option"
                data-mine={chosen || undefined}
                aria-pressed={chosen}
                disabled={poll.closed || busy}
                onClick={() => void vote(option.id)}
              >
                <span
                  className="poll-bar"
                  style={{ width: `${String(percent)}%` }}
                  aria-hidden="true"
                />
                <span className="poll-label">{option.label}</span>
                <span className="poll-count">
                  {option.votes}
                  <span className="poll-percent"> · {percent}%</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="poll-footer">
        <span>
          {poll.closed ? 'Closed' : kind} · {poll.totalVoters}{' '}
          {poll.totalVoters === 1 ? 'person' : 'people'} voted
        </span>
        {isAuthor && !poll.closed && (
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => void close()}
          >
            Close poll
          </button>
        )}
      </div>
    </div>
  );
}
