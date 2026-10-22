import type { Message } from '@harmony/shared';
import { useState, type ReactNode } from 'react';
import { QUICK_REACTIONS } from '../lib/emoji.js';
import { useApp } from '../store/store.js';
import { useMessageHandlers } from './chat-context.js';
import { EmojiGrid } from './EmojiPicker.js';
import { CopyIcon, EditIcon, PinIcon, ReplyIcon, SmileIcon, TrashIcon } from './Icons.js';
import { Modal } from './Overlay.js';

interface Props {
  message: Message | null;
  onClose: () => void;
}

function Action({
  icon,
  danger = false,
  onClick,
  children,
}: {
  icon: ReactNode;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={danger ? 'sheet-action sheet-action-danger' : 'sheet-action'}
      onClick={onClick}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

/** The phone replacement for hover actions: opened by long-pressing a message. */
export function MessageSheet({ message, onClose }: Props) {
  const { meId, nameOf, onReply, onStartEdit, onDelete, onTogglePin, onCopy, onReact } =
    useMessageHandlers();
  const isAdmin = useApp((state) => state.me?.isAdmin ?? false);
  const [picking, setPicking] = useState(false);

  const close = () => {
    setPicking(false);
    onClose();
  };
  const run = (action: (message: Message) => void) => () => {
    if (!message) return;
    close();
    action(message);
  };
  const mine = message?.author.id === meId;

  return (
    <Modal
      open={message !== null}
      onOpenChange={(open) => !open && close()}
      title="Message actions"
      variant="sheet"
      graceMs={600}
      hideTitle
    >
      {message && (
        <div className="sheet">
          <p className="sheet-preview">
            <strong>{nameOf(message.author.id) ?? message.author.displayName}</strong>{' '}
            {message.content.slice(0, 120) || 'Attachment'}
          </p>
          {picking ? (
            <EmojiGrid onPick={(emoji) => (close(), onReact(message, emoji))} />
          ) : (
            <>
              <div className="sheet-reactions" role="group" aria-label="Quick reactions">
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="sheet-emoji"
                    aria-label={`React with ${emoji}`}
                    onClick={() => (close(), onReact(message, emoji))}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <div className="sheet-actions">
                <Action icon={<ReplyIcon />} onClick={run(onReply)}>
                  Reply
                </Action>
                <Action icon={<SmileIcon />} onClick={() => setPicking(true)}>
                  Add reaction
                </Action>
                {mine && (
                  <Action icon={<EditIcon />} onClick={run(onStartEdit)}>
                    Edit message
                  </Action>
                )}
                <Action icon={<PinIcon />} onClick={run(onTogglePin)}>
                  {message.pinnedAt ? 'Unpin message' : 'Pin message'}
                </Action>
                <Action icon={<CopyIcon />} onClick={run(onCopy)}>
                  Copy text
                </Action>
                {(mine || isAdmin) && (
                  <Action danger icon={<TrashIcon />} onClick={run(onDelete)}>
                    Delete message
                  </Action>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
