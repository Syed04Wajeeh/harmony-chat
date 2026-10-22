import type { Message } from '@harmony/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useNameOf } from '../../hooks/useNameOf.js';
import { decodeMentions } from '../../lib/mentions.js';
import { formatTimestamp } from '../../lib/time.js';
import { reportError } from '../../store/actions.js';
import { useApp } from '../../store/store.js';
import { CloseIcon, SearchIcon } from '../../components/Icons.js';

interface Props {
  channelId: string;
  channelLabel: string;
  onClose: () => void;
  onPick: (message: Message) => void;
}

type Scope = 'channel' | 'all';

/** Search hits are previews, so drop emphasis markers instead of rendering Markdown. */
const plain = (text: string) =>
  text
    .replace(/[*~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function Snippet({ text, query }: { text: string; query: string }) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^[-"]+|"+$/g, ''))
    .filter((term) => term.length > 0 && term !== 'or');
  const pieces = terms.length
    ? text.split(
        new RegExp(
          `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
          'gi',
        ),
      )
    : [text];
  return (
    <span className="search-snippet">
      {pieces.map((piece, index) =>
        terms.includes(piece.toLowerCase()) ? <mark key={index}>{piece}</mark> : piece,
      )}
    </span>
  );
}

export function SearchPanel({ channelId, channelLabel, onClose, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('channel');
  const [results, setResults] = useState<Message[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const channels = useApp((state) => state.channels);
  const guilds = useApp((state) => state.guilds);
  const input = useRef<HTMLInputElement>(null);
  const shown = query.trim() ? results : null;
  const nameOf = useNameOf();

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .search({ q, ...(scope === 'channel' && { channelId }), signal: controller.signal })
        .then((page) => {
          setResults(page.messages);
          setHasMore(page.hasMore);
        })
        .catch((error: unknown) => reportError(error, 'Search failed'))
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, scope, channelId]);

  async function loadMore() {
    const last = results?.at(-1);
    if (!last) return;
    try {
      const page = await api.search({
        q: query.trim(),
        ...(scope === 'channel' && { channelId }),
        before: last.id,
      });
      setResults((current) => [...(current ?? []), ...page.messages]);
      setHasMore(page.hasMore);
    } catch (error) {
      reportError(error, 'Search failed');
    }
  }

  const where = (message: Message) => {
    const channel = channels[message.channelId];
    if (!channel) return '';
    if (channel.kind === 'dm') return channel.dmUser?.displayName ?? 'Direct message';
    const guild = channel.guildId ? guilds[channel.guildId] : undefined;
    return `${guild?.name ?? ''} #${channel.name ?? ''}`.trim();
  };

  return (
    <section className="search-panel" aria-label="Search">
      <header className="search-header">
        <SearchIcon className="search-icon" />
        <input
          ref={input}
          type="search"
          className="search-input"
          placeholder="Search messages"
          aria-label="Search messages"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && onClose()}
        />
        <button className="icon-button" aria-label="Close search" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="search-scope" role="radiogroup" aria-label="Search in">
        {(['channel', 'all'] as const).map((value) => (
          <button
            key={value}
            role="radio"
            aria-checked={scope === value}
            className="chip"
            data-active={scope === value || undefined}
            onClick={() => setScope(value)}
          >
            {value === 'channel' ? `In ${channelLabel}` : 'All my channels'}
          </button>
        ))}
      </div>
      <div className="search-results">
        {shown === null && (
          <p className="empty-note">
            Type to search. Words are matched whole; use "quotes" for phrases.
          </p>
        )}
        {shown?.length === 0 && !loading && <p className="empty-note">No messages found.</p>}
        <ul>
          {shown?.map((message) => (
            <li key={message.id}>
              <button className="search-result" onClick={() => onPick(message)}>
                <span className="search-result-meta">
                  <strong>{message.author.displayName}</strong>
                  <span className="search-result-where">{where(message)}</span>
                  <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
                </span>
                <Snippet
                  text={plain(decodeMentions(message.content, nameOf).text) || 'Attachment'}
                  query={query}
                />
              </button>
            </li>
          ))}
        </ul>
        {hasMore && (
          <button className="button search-more" onClick={() => void loadMore()}>
            Load more
          </button>
        )}
      </div>
    </section>
  );
}
