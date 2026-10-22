import * as Popover from '@radix-ui/react-popover';
import type { Message } from '@harmony/shared';
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useNameOf } from '../hooks/useNameOf.js';
import { decodeMentions } from '../lib/mentions.js';
import { formatTimestamp } from '../lib/time.js';
import { reportError } from '../store/actions.js';
import { useApp } from '../store/store.js';
import { PinIcon } from './Icons.js';

interface Props {
  channelId: string;
  onJump: (messageId: string) => void;
}

export function PinsPopover({ channelId, onJump }: Props) {
  const [open, setOpen] = useState(false);
  const [pins, setPins] = useState<Message[] | null>(null);
  const nameOf = useNameOf();
  const history = useApp((state) => state.history[channelId]);
  // Pin/unpin arrives as message.updated; refetch when the cached pin set changes while open.
  const pinSignature = history?.messages.map((m) => (m.pinnedAt ? m.id : '')).join('');

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    api
      .pins(channelId, controller.signal)
      .then(setPins)
      .catch((error: unknown) => reportError(error, 'Could not load pins'));
    return () => controller.abort();
  }, [open, channelId, pinSignature]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="icon-button" aria-label="Pinned messages">
        <PinIcon />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="popover pins-popover"
          align="end"
          sideOffset={8}
          collisionPadding={12}
        >
          <h3 className="popover-title">Pinned messages</h3>
          {pins === null && <p className="empty-note">Loading…</p>}
          {pins?.length === 0 && (
            <p className="empty-note">Nothing is pinned in this channel yet.</p>
          )}
          <ul className="pin-list">
            {pins?.map((message) => (
              <li key={message.id}>
                <button
                  className="pin-item"
                  onClick={() => {
                    setOpen(false);
                    onJump(message.id);
                  }}
                >
                  <span className="pin-item-meta">
                    <strong>{message.author.displayName}</strong>
                    <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
                  </span>
                  <span className="pin-item-text">
                    {decodeMentions(message.content, nameOf).text || 'Attachment'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
