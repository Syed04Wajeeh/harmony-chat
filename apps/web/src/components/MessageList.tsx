import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Message, User } from '@harmony/shared';
import type { OutboxItem } from '../hooks/messageState.js';
import { Avatar } from './Avatar.js';

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const LOAD_OLDER_THRESHOLD_PX = 120;
const STICK_THRESHOLD_PX = 80;

export interface ViewItem {
  key: string;
  author: User;
  content: string;
  createdAt: string;
  status: 'sent' | 'pending' | 'failed';
}

/** Merges stored and outgoing messages into one display list. */
export function toViewItems(messages: Message[], outbox: OutboxItem[], me: User): ViewItem[] {
  return [
    ...messages.map((m): ViewItem => ({
      key: m.id,
      author: m.author,
      content: m.content,
      createdAt: m.createdAt,
      status: 'sent',
    })),
    ...outbox.map((o): ViewItem => ({
      key: `pending-${o.nonce}`,
      author: me,
      content: o.content,
      createdAt: o.createdAt,
      status: o.status,
    })),
  ];
}

/** A message continues the previous group if the same author wrote it within five minutes. */
export function startsGroup(item: ViewItem, previous: ViewItem | undefined): boolean {
  return (
    !previous ||
    previous.author.id !== item.author.id ||
    Date.parse(item.createdAt) - Date.parse(previous.createdAt) > GROUP_WINDOW_MS
  );
}

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
const clockFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

interface MessageListProps {
  items: ViewItem[];
  hasMore: boolean;
  loaded: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}

export function MessageList({
  items,
  hasMore,
  loaded,
  loadingOlder,
  onLoadOlder,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previous = useRef({ firstKey: '', lastKey: '', scrollHeight: 0 });

  const rows = useMemo(
    () => items.map((item, index) => ({ item, grouped: !startsGroup(item, items[index - 1]) })),
    [items],
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const firstKey = items[0]?.key ?? '';
    const lastKey = items.at(-1)?.key ?? '';
    const prev = previous.current;

    if (prev.firstKey && firstKey !== prev.firstKey && lastKey === prev.lastKey) {
      // Older messages were prepended: keep the viewport anchored on what was visible.
      el.scrollTop += el.scrollHeight - prev.scrollHeight;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    previous.current = { firstKey, lastKey, scrollHeight: el.scrollHeight };

    // A short first page may not scroll at all, so the scroll handler would never fire.
    if (hasMore && !loadingOlder && el.scrollHeight <= el.clientHeight) onLoadOlder();
  }, [items, hasMore, loadingOlder, onLoadOlder]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX && hasMore && !loadingOlder) onLoadOlder();
  }

  return (
    <div className="messages" ref={containerRef} onScroll={handleScroll}>
      {loadingOlder && <p className="notice">Loading older messages...</p>}
      {!hasMore && loaded && <p className="notice">This is the beginning of the channel.</p>}
      {rows.map(({ item, grouped }) => (
        <article key={item.key} className={`message ${grouped ? 'grouped' : ''} ${item.status}`}>
          {grouped ? (
            <time className="gutter-time" dateTime={item.createdAt}>
              {clockFormat.format(new Date(item.createdAt))}
            </time>
          ) : (
            <Avatar user={item.author} />
          )}
          <div className="body">
            {!grouped && (
              <header>
                <span className="author">{item.author.displayName}</span>
                <time dateTime={item.createdAt}>{timeFormat.format(new Date(item.createdAt))}</time>
              </header>
            )}
            <p className="content">{item.content}</p>
            {item.status === 'failed' && <span className="failed-note">Failed to send</span>}
          </div>
        </article>
      ))}
    </div>
  );
}
