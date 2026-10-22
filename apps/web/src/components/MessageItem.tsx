import { MAX_MESSAGE_LENGTH, type Message } from '@harmony/shared';
import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useCoarsePointer } from '../hooks/useMediaQuery.js';
import { useLongPress } from '../hooks/useLongPress.js';
import { decodeMentions, encodeMentions } from '../lib/mentions.js';
import { messageIdentity } from '../lib/identity.js';
import { Markdown } from './Markdown.js';
import { formatAbsolute, formatClock, formatTimestamp } from '../lib/time.js';
import type { OutboxItem } from '../store/store.js';
import { Attachments } from './Attachments.js';
import { Avatar } from './Avatar.js';
import { AuthorBadge } from './AuthorBadge.js';
import { Embeds } from './Embeds.js';
import { useMessageHandlers } from './chat-context.js';
import { EmojiPickerButton } from './EmojiPicker.js';
import { CopyIcon, EditIcon, PinIcon, ReplyIcon, SmileIcon, TrashIcon } from './Icons.js';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './Menu.js';
import { ProfilePopover } from './ProfilePopover.js';
import { Reactions } from './Reactions.js';
import { useApp } from '../store/store.js';

interface Props {
  message: Message;
  grouped: boolean;
  /** Set for optimistic copies that the server has not confirmed. */
  pending?: OutboxItem;
  onRetry?: () => void;
  onDiscard?: () => void;
}

function ReplyQuote({ message }: { message: Message }) {
  const { onJump } = useMessageHandlers();
  const author = useApp((state) => state.users[message.replyTo?.authorId ?? '']);
  const reply = message.replyTo;
  if (!reply) return null;
  if (reply.deleted) {
    return <div className="reply-quote reply-quote-deleted">Original message was deleted</div>;
  }
  return (
    <button type="button" className="reply-quote" onClick={() => onJump(reply.id)}>
      <ReplyIcon width={14} height={14} className="reply-quote-icon" />
      <span className="reply-quote-author">{author?.displayName ?? 'Unknown user'}</span>
      <span className="reply-quote-text">{reply.contentPreview.replace(/\s+/g, ' ')}</span>
    </button>
  );
}

function InlineEditor({ message }: { message: Message }) {
  const { nameOf, onSaveEdit, onCancelEdit } = useMessageHandlers();
  const coarse = useCoarsePointer();
  const [initial] = useState(() => decodeMentions(message.content, nameOf));
  const [text, setText] = useState(initial.text);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${String(el.scrollHeight)}px`;
  }, [text]);

  const content = encodeMentions(text.trim(), initial.mentions);
  const save = async () => {
    if (!content || busy) return;
    if (content === message.content) return onCancelEdit();
    setBusy(true);
    await onSaveEdit(message, content);
    setBusy(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onCancelEdit();
    else if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !coarse &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <div className="inline-editor">
      <textarea
        ref={field}
        value={text}
        rows={1}
        maxLength={MAX_MESSAGE_LENGTH}
        aria-label="Edit message"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="inline-editor-actions">
        <span className="inline-editor-hint">{coarse ? '' : 'Esc to cancel, Enter to save'}</span>
        <button type="button" className="button" onClick={onCancelEdit}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={!content || busy}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function HoverToolbar({ message, mine }: { message: Message; mine: boolean }) {
  const { onReply, onStartEdit, onDelete, onTogglePin, onCopy, onReact } = useMessageHandlers();
  const isAdmin = useApp((state) => state.me?.isAdmin ?? false);
  return (
    <div className="message-toolbar" role="toolbar" aria-label="Message actions">
      <EmojiPickerButton
        label="Add reaction"
        className="icon-button icon-button-small"
        onPick={(emoji) => onReact(message, emoji)}
      >
        <SmileIcon width={18} height={18} />
      </EmojiPickerButton>
      <button
        className="icon-button icon-button-small"
        aria-label="Reply"
        onClick={() => onReply(message)}
      >
        <ReplyIcon width={18} height={18} />
      </button>
      {mine && (
        <button
          className="icon-button icon-button-small"
          aria-label="Edit message"
          onClick={() => onStartEdit(message)}
        >
          <EditIcon width={18} height={18} />
        </button>
      )}
      <Menu>
        <MenuTrigger className="icon-button icon-button-small" aria-label="More actions">
          <span aria-hidden="true">⋯</span>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<PinIcon />} onSelect={() => onTogglePin(message)}>
            {message.pinnedAt ? 'Unpin message' : 'Pin message'}
          </MenuItem>
          <MenuItem icon={<CopyIcon />} onSelect={() => onCopy(message)}>
            Copy text
          </MenuItem>
          {(mine || isAdmin) && (
            <MenuItem danger icon={<TrashIcon />} onSelect={() => onDelete(message)}>
              Delete message
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  grouped,
  pending,
  onRetry,
  onDiscard,
}: Props) {
  const handlers = useMessageHandlers();
  const { meId, nameOf, editingId, highlightId, onOpenSheet } = handlers;
  const coarse = useCoarsePointer();
  const longPress = useLongPress(() => onOpenSheet(message), coarse && !pending);

  if (message.deleted) {
    return (
      <li id={`m-${message.id}`} className="message message-tombstone">
        <TrashIcon width={14} height={14} />
        <span>Message deleted</span>
      </li>
    );
  }

  const identity = messageIdentity(message);
  const mine = message.author.id === meId;
  const mentioned = message.mentions.includes(meId);
  const editing = editingId === message.id;

  return (
    <li
      id={`m-${message.id}`}
      className="message"
      data-grouped={grouped || undefined}
      data-mentioned={mentioned || undefined}
      data-pending={pending?.status}
      data-highlight={highlightId === message.id || undefined}
      data-editing={editing || undefined}
      {...(pending ? {} : longPress)}
    >
      {message.replyTo && <ReplyQuote message={message} />}
      <div className="message-row">
        <div className="message-gutter">
          {grouped ? (
            <time
              className="message-hover-time"
              dateTime={message.createdAt}
              title={formatAbsolute(message.createdAt)}
            >
              {formatClock(message.createdAt)}
            </time>
          ) : (
            <ProfilePopover userId={message.author.id}>
              <button
                type="button"
                className="avatar-button"
                aria-label={`${identity.name}'s profile`}
              >
                <Avatar user={identity.avatarUser} size={40} />
              </button>
            </ProfilePopover>
          )}
        </div>
        <div className="message-body">
          {!grouped && (
            <div className="message-header">
              <ProfilePopover userId={message.author.id}>
                <button type="button" className="message-author">
                  {identity.name}
                </button>
              </ProfilePopover>
              {identity.badge && <AuthorBadge kind={identity.badge} />}
              <time dateTime={message.createdAt} title={formatAbsolute(message.createdAt)}>
                {formatTimestamp(message.createdAt)}
              </time>
              {message.pinnedAt && (
                <span className="message-pinned" title="Pinned">
                  <PinIcon width={14} height={14} />
                  <span className="sr-only">Pinned</span>
                </span>
              )}
            </div>
          )}
          {editing ? (
            <InlineEditor message={message} />
          ) : (
            message.content && (
              <div className="message-content">
                <Markdown
                  content={message.content}
                  nameOf={nameOf}
                  meId={meId}
                  suffix={
                    message.editedAt && (
                      <span className="edited" title={`Edited ${formatAbsolute(message.editedAt)}`}>
                        (edited)
                      </span>
                    )
                  }
                />
              </div>
            )
          )}
          {message.embeds && message.embeds.length > 0 && (
            <Embeds embeds={message.embeds} nameOf={nameOf} meId={meId} />
          )}
          <Attachments attachments={message.attachments} />
          {!pending && <Reactions message={message} />}
          {pending?.status === 'failed' && (
            <div className="message-failed" role="alert">
              <span>{pending.error ?? 'Failed to send.'}</span>
              <button type="button" className="link-button" onClick={onRetry}>
                Retry
              </button>
              <button type="button" className="link-button" onClick={onDiscard}>
                Discard
              </button>
            </div>
          )}
        </div>
      </div>
      {!pending && !editing && !coarse && <HoverToolbar message={message} mine={mine} />}
    </li>
  );
});
