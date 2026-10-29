import type { DirectoryUser, PresenceStatus } from '@harmony/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useDirectory } from '../hooks/useDirectory.js';
import { channelPath } from '../lib/paths.js';
import { openDm } from '../store/actions.js';
import { useApp } from '../store/store.js';
import { Avatar } from './Avatar.js';
import { ChatIcon, SearchIcon } from './Icons.js';
import { ProfilePopover } from './ProfilePopover.js';

/** Everyone who has signed in to this Harmony, whether or not you share a server with them. */
export function MemberDirectory() {
  const [query, setQuery] = useState('');
  const people = useDirectory({ query });
  // Bots are listed apart and only when nobody is searching for a person.
  const bots = useDirectory({ query, kind: 'bot', pageSize: 20 });

  return (
    <div className="directory" data-harmony="member-directory">
      <div className="directory-search">
        <SearchIcon width={18} height={18} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search members"
          placeholder="Search members"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="directory-scroll">
        <DirectorySection
          title="Members"
          list={people}
          emptyText={query ? 'Nobody matches that search.' : 'Nobody has signed in yet.'}
        />
        {bots.total > 0 && <DirectorySection title="Bots" list={bots} emptyText="" />}
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  list: ReturnType<typeof useDirectory>;
  emptyText: string;
}

function DirectorySection({ title, list, emptyText }: SectionProps) {
  const { users, total, presence, loading, hasMore, loadMore } = list;
  return (
    <section aria-label={title}>
      <h2 className="directory-heading">
        {title} <span>{total}</span>
      </h2>
      {users.length === 0 && !loading && <p className="sidebar-empty">{emptyText}</p>}
      <ul className="directory-list">
        {users.map((user) => (
          <DirectoryRow key={user.id} user={user} fetched={presence[user.id]} />
        ))}
      </ul>
      {hasMore && (
        <button className="button directory-more" disabled={loading} onClick={loadMore}>
          {loading ? 'Loading…' : 'Show more'}
        </button>
      )}
    </section>
  );
}

function DirectoryRow({ user, fetched }: { user: DirectoryUser; fetched?: PresenceStatus }) {
  const meId = useApp((state) => state.me?.id);
  const live = useApp((state) => state.presence[user.id]);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const status = user.id === meId ? 'online' : (live ?? fetched ?? 'offline');

  async function message() {
    setBusy(true);
    const channel = await openDm(user.id);
    setBusy(false);
    if (channel) void navigate(channelPath(channel));
  }

  return (
    <li className="directory-row" data-offline={status === 'offline' || undefined}>
      <ProfilePopover userId={user.id}>
        <button className="directory-person" aria-label={`Profile of ${user.displayName}`}>
          <Avatar user={user} size={40} status={status} />
          <span className="directory-names">
            <span className="member-name">{user.displayName}</span>
            <small>{user.login}</small>
          </span>
        </button>
      </ProfilePopover>
      {user.id !== meId && (
        <button
          className="button directory-message"
          disabled={busy}
          onClick={() => void message()}
          aria-label={`Message ${user.displayName}`}
        >
          <ChatIcon width={18} height={18} />
          <span>Message</span>
        </button>
      )}
    </li>
  );
}
