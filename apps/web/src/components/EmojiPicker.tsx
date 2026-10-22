import * as Popover from '@radix-ui/react-popover';
import { useState, type ReactNode } from 'react';
import { searchEmoji } from '../lib/emoji.js';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { Modal } from './Overlay.js';

export function EmojiGrid({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState('');
  const results = searchEmoji(query);
  return (
    <div className="emoji-picker">
      <input
        type="search"
        className="emoji-search"
        placeholder="Search emoji"
        aria-label="Search emoji"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="emoji-grid" role="listbox" aria-label="Emoji">
        {results.map((entry) => (
          <button
            key={entry.emoji}
            type="button"
            role="option"
            aria-selected={false}
            className="emoji-option"
            title={entry.name}
            aria-label={entry.name}
            onClick={() => onPick(entry.emoji)}
          >
            {entry.emoji}
          </button>
        ))}
        {results.length === 0 && <p className="empty-note">No emoji found.</p>}
      </div>
    </div>
  );
}

interface ButtonProps {
  onPick: (emoji: string) => void;
  label: string;
  className?: string;
  children: ReactNode;
}

/** A button that opens the picker: a popover on desktop, a bottom sheet on phones. */
export function EmojiPickerButton({ onPick, label, className, children }: ButtonProps) {
  const [open, setOpen] = useState(false);
  const desktop = useIsDesktop();
  const pick = (emoji: string) => {
    setOpen(false);
    onPick(emoji);
  };

  if (!desktop) {
    return (
      <>
        <button
          type="button"
          className={className}
          aria-label={label}
          onClick={() => setOpen(true)}
        >
          {children}
        </button>
        <Modal open={open} onOpenChange={setOpen} title={label} variant="sheet">
          <EmojiGrid onPick={pick} />
        </Modal>
      </>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={className} aria-label={label}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover emoji-popover" sideOffset={6} collisionPadding={12}>
          <EmojiGrid onPick={pick} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
