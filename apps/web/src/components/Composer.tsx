import { useState, type KeyboardEvent } from 'react';
import { MAX_MESSAGE_LENGTH } from '@harmony/shared';

interface ComposerProps {
  channelName: string;
  disabled: boolean;
  onSend: (content: string) => boolean;
}

export function Composer({ channelName, disabled, onSend }: ComposerProps) {
  const [draft, setDraft] = useState('');

  function submit() {
    const content = draft.trim();
    if (content && onSend(content)) setDraft('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        value={draft}
        rows={1}
        maxLength={MAX_MESSAGE_LENGTH}
        disabled={disabled}
        placeholder={disabled ? 'Reconnecting...' : `Message #${channelName}`}
        aria-label={`Message #${channelName}`}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    </form>
  );
}
