import { useEffect } from 'react';
import { typingText } from '../lib/typing.js';
import { appStore, useApp } from '../store/store.js';

export function TypingIndicator({ channelId }: { channelId: string }) {
  const typing = useApp((state) => state.typing[channelId]);
  const users = useApp((state) => state.users);
  const active = typing && Object.keys(typing).length > 0;

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => appStore.getState().pruneTyping(), 1000);
    return () => clearInterval(id);
  }, [active]);

  const names = Object.keys(typing ?? {}).map((id) => users[id]?.displayName ?? 'Someone');
  const text = typingText(names);
  return (
    <div className="typing" aria-live="polite" aria-atomic="true">
      {text && (
        <>
          <span className="typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>{text}</span>
        </>
      )}
    </div>
  );
}
