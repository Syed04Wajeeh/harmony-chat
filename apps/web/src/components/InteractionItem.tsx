import { describeFailure } from '../lib/errors.js';
import type { LocalInteraction } from '../store/interactions.js';
import { appStore, useApp } from '../store/store.js';
import { Avatar } from './Avatar.js';
import { AuthorBadge } from './AuthorBadge.js';
import { useMessageHandlers } from './chat-context.js';
import { Embeds } from './Embeds.js';
import { EyeIcon } from './Icons.js';
import { Markdown } from './Markdown.js';

/** A slash command outcome that only this client knows about. */
export function InteractionItem({
  item,
  channelId,
}: {
  item: LocalInteraction;
  channelId: string;
}) {
  const { nameOf, meId } = useMessageHandlers();
  const bot = useApp((state) => (item.botId ? state.users[item.botId] : undefined));
  const name = item.source ?? bot?.displayName ?? 'The bot';
  const dismiss = () => appStore.getState().dismissInteraction(channelId, item.key);

  if (item.kind === 'failed') {
    return (
      <li className="message message-local" data-kind="failed">
        <div className="message-failed" role="alert">
          <span>
            <strong>{item.action ? item.command : `/${item.command}`}</strong> failed: {name}{' '}
            {describeFailure(item.reason)}.
          </span>
          <button type="button" className="link-button" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      </li>
    );
  }

  const author = {
    id: item.botId ?? item.source ?? 'app',
    displayName: name,
    avatarUrl: bot?.avatarUrl ?? null,
  };
  return (
    <li className="message message-local" data-kind={item.kind}>
      <div className="message-row">
        <div className="message-gutter">
          <Avatar user={author} size={40} />
        </div>
        <div className="message-body">
          <div className="message-header">
            <span className="message-author">{name}</span>
            {item.botId && <AuthorBadge kind="bot" />}
            <span className="message-command">
              {item.action ? `answered ${item.command}` : `used /${item.command}`}
            </span>
          </div>
          {item.kind === 'pending' ? (
            <div className="thinking" role="status">
              <span className="typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {name} is thinking…
            </div>
          ) : (
            <>
              {item.content && (
                <div className="message-content">
                  <Markdown content={item.content} nameOf={nameOf} meId={meId} />
                </div>
              )}
              <Embeds embeds={item.embeds} nameOf={nameOf} meId={meId} />
              <div className="local-note">
                <EyeIcon width={14} height={14} />
                <span>
                  Only you can see this ·{' '}
                  <button type="button" className="link-button" onClick={dismiss}>
                    Dismiss
                  </button>
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </li>
  );
}
