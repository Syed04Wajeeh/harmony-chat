import type { Message } from '@harmony/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { prefersReducedMotion } from '../hooks/useMediaQuery.js';
import type { TimelineItem } from '../lib/timeline.js';
import type { LocalInteraction } from '../store/interactions.js';
import type { OutboxItem } from '../store/store.js';
import { ArrowDownIcon } from './Icons.js';
import { InteractionItem } from './InteractionItem.js';
import { MessageItem } from './MessageItem.js';

const BOTTOM_THRESHOLD_PX = 64;
const LOAD_OLDER_THRESHOLD_PX = 400;

export interface PendingMessage {
  item: OutboxItem;
  message: Message;
}

interface Props {
  items: readonly TimelineItem[];
  pending: readonly PendingMessage[];
  interactions: readonly LocalInteraction[];
  channelId: string;
  loaded: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onBottomChange: (atBottom: boolean) => void;
  onRetry: (item: OutboxItem) => void;
  onDiscard: (item: OutboxItem) => void;
  empty: ReactNode;
}

interface Snapshot {
  firstId: string | null;
  lastId: string | null;
  height: number;
}

export function MessageList({
  items,
  pending,
  interactions,
  channelId,
  loaded,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onBottomChange,
  onRetry,
  onDiscard,
  empty,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLOListElement>(null);
  const stuck = useRef(true);
  const snapshot = useRef<Snapshot | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [missed, setMissed] = useState(0);

  const messageItems = items.filter((item) => item.kind === 'message');
  const firstId = messageItems[0]?.key ?? null;
  // Things only this user sees (unsent messages, command replies) sit below the history.
  const localKey =
    [pending.at(-1)?.item.nonce, interactions.at(-1)?.key].filter(Boolean).join('|') || null;
  const lastId = localKey ?? messageItems.at(-1)?.key ?? null;

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto',
    });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = distance < BOTTOM_THRESHOLD_PX;
    stuck.current = bottom;
    setAtBottom(bottom);
    if (bottom) setMissed(0);
    if (snapshot.current) snapshot.current.height = el.scrollHeight;
    if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX && hasMore && !loadingOlder) onLoadOlder();
  }, [hasMore, loadingOlder, onLoadOlder]);

  useEffect(() => onBottomChange(atBottom), [atBottom, onBottomChange]);

  // Keep the viewport steady as the list changes under it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || (firstId === null && lastId === null)) return;
    const previous = snapshot.current;
    const ownPending = localKey !== null && localKey === lastId && lastId !== previous?.lastId;

    if (!previous || (firstId !== previous.firstId && lastId !== previous.lastId)) {
      el.scrollTop = el.scrollHeight;
    } else if (firstId !== previous.firstId) {
      // Older messages were added above: shift by the height they added.
      el.scrollTop += el.scrollHeight - previous.height;
    } else if (lastId !== previous.lastId) {
      if (stuck.current || ownPending) el.scrollTop = el.scrollHeight;
      else setMissed((count) => count + 1);
    }
    snapshot.current = { firstId, lastId, height: el.scrollHeight };
  }, [firstId, lastId, localKey]);

  // Late layout changes (fonts, the keyboard resizing the viewport) keep a stuck list at the bottom.
  useEffect(() => {
    const el = scroller.current;
    const list = content.current;
    if (!el || !list) return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
      if (snapshot.current) snapshot.current.height = el.scrollHeight;
    });
    observer.observe(el);
    observer.observe(list);
    return () => observer.disconnect();
  }, [loaded]);

  const hasContent = items.length > 0 || pending.length > 0 || interactions.length > 0;

  return (
    <div className="message-area">
      <div
        ref={scroller}
        className="message-scroller"
        data-harmony="message-list"
        onScroll={handleScroll}
      >
        {loaded && !hasMore && hasContent && (
          <div className="list-start">This is the start of the conversation.</div>
        )}
        {loadingOlder && (
          <div className="list-loading" role="status">
            <span className="spinner" aria-hidden="true" /> Loading earlier messages…
          </div>
        )}
        {!loaded && (
          <div className="list-loading">
            <span className="spinner" aria-hidden="true" /> Loading…
          </div>
        )}
        {loaded && !hasContent && empty}
        <ol ref={content} className="messages" aria-label="Messages">
          {items.map((item) => {
            switch (item.kind) {
              case 'day':
                return (
                  <li
                    key={item.key}
                    className="day-separator"
                    role="separator"
                    aria-label={item.label}
                  >
                    <span>{item.label}</span>
                  </li>
                );
              case 'unread':
                return (
                  <li
                    key={item.key}
                    className="unread-divider"
                    role="separator"
                    aria-label="New messages"
                  >
                    <span>New</span>
                  </li>
                );
              case 'message':
                return <MessageItem key={item.key} message={item.message} grouped={item.grouped} />;
            }
          })}
          {pending.map(({ item, message }) => (
            <MessageItem
              key={item.nonce}
              message={message}
              grouped={false}
              pending={item}
              onRetry={() => onRetry(item)}
              onDiscard={() => onDiscard(item)}
            />
          ))}
          {interactions.map((item) => (
            <InteractionItem key={item.key} item={item} channelId={channelId} />
          ))}
        </ol>
      </div>
      {!atBottom && (
        <button
          type="button"
          className="jump-present"
          onClick={() => {
            scrollToBottom(true);
          }}
        >
          <ArrowDownIcon width={16} height={16} />
          {missed > 0
            ? `${String(missed)} new ${missed === 1 ? 'message' : 'messages'}`
            : 'Jump to present'}
        </button>
      )}
    </div>
  );
}
