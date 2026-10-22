import type { Message } from '@harmony/shared';
import { EmojiPickerButton } from './EmojiPicker.js';
import { useMessageHandlers } from './chat-context.js';
import { SmileIcon } from './Icons.js';

export function Reactions({ message }: { message: Message }) {
  const { meId, nameOf, onReact } = useMessageHandlers();
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
