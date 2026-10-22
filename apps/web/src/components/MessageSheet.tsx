import type { Message } from '@harmony/shared';
import type { ReactNode } from 'react';
import { MessageSheetSlots, useMessageActions } from '../modules/slots.js';
import { useCanDelete } from '../hooks/usePermission.js';
import { useMessageHandlers } from './chat-context.js';
import { CopyIcon, EditIcon, ReplyIcon, TrashIcon } from './Icons.js';
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

function SheetBody({ message, close }: { message: Message; close: () => void }) {
  const { meId, nameOf, onReply, onStartEdit, onDelete, onCopy } = useMessageHandlers();
  const canDelete = useCanDelete(message);
  const actions = useMessageActions(message);
  const run = (action: (message: Message) => void) => () => {
    close();
    action(message);
  };
  const mine = message.author.id === meId;

  return (
    <div className="sheet">
      <p className="sheet-preview">
        <strong>{nameOf(message.author.id) ?? message.author.displayName}</strong>{' '}
        {message.content.slice(0, 120) || 'Attachment'}
      </p>
      <MessageSheetSlots message={message} close={close} />
      <div className="sheet-actions">
        <Action icon={<ReplyIcon />} onClick={run(onReply)}>
          Reply
        </Action>
        {mine && (
          <Action icon={<EditIcon />} onClick={run(onStartEdit)}>
            Edit message
          </Action>
        )}
        {actions.map((action) => (
          <Action
            key={action.id}
            icon={<action.icon />}
            onClick={() => (close(), action.onSelect())}
          >
            {action.label}
          </Action>
        ))}
        <Action icon={<CopyIcon />} onClick={run(onCopy)}>
          Copy text
        </Action>
        {canDelete && (
          <Action danger icon={<TrashIcon />} onClick={run(onDelete)}>
            Delete message
          </Action>
        )}
      </div>
    </div>
  );
}

/** The phone replacement for hover actions: opened by long-pressing a message. */
export function MessageSheet({ message, onClose }: Props) {
  return (
    <Modal
      open={message !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Message actions"
      variant="sheet"
      graceMs={600}
      hideTitle
    >
      {message && <SheetBody message={message} close={onClose} />}
    </Modal>
  );
}
