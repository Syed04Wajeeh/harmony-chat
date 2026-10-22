import type { Message } from '@harmony/shared';
import { useState } from 'react';
import { EmojiGrid, EmojiPickerButton } from '../../components/EmojiPicker.js';
import { SmileIcon } from '../../components/Icons.js';
import { useMessageHandlers } from '../../components/chat-context.js';
import { QUICK_REACTIONS } from '../../lib/emoji.js';
import { useGuildAccess } from '../../hooks/usePermission.js';
import { toggleReaction } from '../../store/actions.js';
import { useApp } from '../../store/store.js';

/** Whether the signed-in user may add reactions in the message's channel. */
function useCanReact(message: Message): boolean {
  const guildId = useApp((state) => state.channels[message.channelId]?.guildId ?? null);
  const access = useGuildAccess(guildId ?? '', guildId ? message.channelId : undefined);
  return guildId === null || !access.loaded || access.has('add_reactions');
}

/** The reaction chips under a message, with a button to add another. */
export function Reactions({ message }: { message: Message }) {
  const { meId, nameOf } = useMessageHandlers();
  const onReact = (target: Message, emoji: string) => void toggleReaction(target, emoji);
  if (message.reactions.length === 0) return null;
  return (
    <div className="reactions">
      {message.reactions.map((reaction) => {
        const mine = reaction.userIds.includes(meId);
        const names = reaction.userIds.map((id) => nameOf(id) ?? 'Someone').join(', ');
        return (
          <button
            key={reaction.emoji}
            type="button"
            className="reaction"
            data-mine={mine || undefined}
            aria-pressed={mine}
            aria-label={`${reaction.emoji} ${String(reaction.count)}${mine ? ', you reacted' : ''}`}
            title={names}
            onClick={() => onReact(message, reaction.emoji)}
          >
            <span className="reaction-emoji">{reaction.emoji}</span>
            <span className="reaction-count">{reaction.count}</span>
          </button>
        );
      })}
      <EmojiPickerButton
        label="Add reaction"
        className="reaction reaction-add"
        onPick={(emoji) => onReact(message, emoji)}
      >
        <SmileIcon width={18} height={18} />
      </EmojiPickerButton>
    </div>
  );
}

/** The hover toolbar's "add reaction" button. */
export function ReactionToolbarButton({ message }: { message: Message }) {
  const canReact = useCanReact(message);
  if (!canReact) return null;
  return (
    <EmojiPickerButton
      label="Add reaction"
      className="icon-button icon-button-small"
      onPick={(emoji) => void toggleReaction(message, emoji)}
    >
      <SmileIcon width={18} height={18} />
    </EmojiPickerButton>
  );
}

/** Quick reactions and the full picker for the phone action sheet. */
export function ReactionSheetSection({ message, close }: { message: Message; close: () => void }) {
  const [picking, setPicking] = useState(false);
  const canReact = useCanReact(message);
  const react = (emoji: string) => {
    close();
    void toggleReaction(message, emoji);
  };
  if (!canReact) return null;
  if (picking) return <EmojiGrid onPick={react} />;
  return (
    <>
      <div className="sheet-reactions" role="group" aria-label="Quick reactions">
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="sheet-emoji"
            aria-label={`React with ${emoji}`}
            onClick={() => react(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      <div className="sheet-actions">
        <button type="button" className="sheet-action" onClick={() => setPicking(true)}>
          <SmileIcon />
          <span>Add reaction</span>
        </button>
      </div>
    </>
  );
}
