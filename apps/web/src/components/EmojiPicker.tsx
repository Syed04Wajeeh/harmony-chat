import * as Popover from '@radix-ui/react-popover';
import { useState, type ReactNode } from 'react';
import { searchEmoji } from '../lib/emoji.js';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { useProfiles } from '../store/profiles.js';
import { useApp } from '../store/store.js';
import { CustomEmoji } from './Emoji.js';
import { Modal } from './Overlay.js';
import { PerkBadge } from './PerkBadge.js';

/** Custom emoji grouped by server: the one on screen first. Other servers need the cross-server perk. */
function CustomSections({ query, onPick }: { query: string; onPick: (emoji: string) => void }) {
  const all = useProfiles((state) => state.emoji);
  const currentGuild = useApp((state) => {
    const channelId = state.activeChannelId;
    return channelId ? (state.channels[channelId]?.guildId ?? null) : null;
  });
  const guilds = useApp((state) => state.guilds);
  const needle = query.trim().toLowerCase().replace(/^:|:$/g, '');
  const matching = all.filter((emoji) => emoji.name.includes(needle));
  const groups = [...new Set(matching.map((emoji) => emoji.guildId))].sort(
    (a, b) => Number(b === currentGuild) - Number(a === currentGuild),
  );
  return (
    <>
      {groups.map((guildId) => {
        const own = guildId === currentGuild;
        const items = matching.filter((emoji) => emoji.guildId === guildId);
        const locked = !own && !items[0]?.usable;
        return (
          <section key={guildId} className="emoji-section" data-locked={locked || undefined}>
            <h3 className="emoji-section-title">
              {guilds[guildId]?.name ?? 'Server'}
              {locked && <PerkBadge perk="cross_server_emoji" />}
            </h3>
            <div
              className="emoji-grid"
              role="group"
              aria-label={`${guilds[guildId]?.name ?? ''} emoji`}
            >
              {items.map((emoji) => (
                <button
                  key={emoji.id}
                  type="button"
                  className="emoji-option"
                  title={`:${emoji.name}:`}
                  aria-label={emoji.name}
                  disabled={locked}
                  onClick={() => onPick(`<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`)}
                >
                  <CustomEmoji id={emoji.id} name={emoji.name} />
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

export function EmojiGrid({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState('');
  const results = searchEmoji(query);
  const hasCustom = useProfiles((state) => state.emoji.length > 0);
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
      <CustomSections query={query} onPick={onPick} />
      {hasCustom && !query && <h3 className="emoji-section-title">Standard</h3>}
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
        {results.length === 0 && <p className="empty-note">No Unicode emoji found.</p>}
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
