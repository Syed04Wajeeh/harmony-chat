import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { attempt } from '../../store/actions.js';
import { useDirectory } from '../../hooks/useDirectory.js';
import { Avatar } from '../Avatar.js';
import { CheckIcon, CopyIcon, SearchIcon } from '../Icons.js';
import { Modal } from '../Overlay.js';
import { SEND_INVITES_MAX, type DirectoryUser } from '@harmony/shared';

interface Props {
  guildId: string;
  guildName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InviteDialog({ guildId, guildName, open, onOpenChange }: Props) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void attempt(api.createInvite(guildId), 'Could not create an invite').then((invite) => {
      if (invite && !cancelled) setLink(`${window.location.origin}/invite/${invite.code}`);
    });
    return () => {
      cancelled = true;
    };
  }, [open, guildId]);

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Invite people to ${guildName}`}
      description="Send an invite to people on this Harmony, or share the link."
    >
      <MemberPicker guildId={guildId} />
      <h3 className="invite-subheading">Or share a link</h3>
      <div className="copy-row">
        <input
          readOnly
          aria-label="Invite link"
          value={link ?? 'Creating link…'}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button className="button button-primary" disabled={!link} onClick={() => void copy()}>
          {copied ? <CheckIcon width={18} height={18} /> : <CopyIcon width={18} height={18} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Modal>
  );
}

/** Search the instance's people (outside this server) and DM each of them an invite card. */
function MemberPicker({ guildId }: { guildId: string }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Map<string, DirectoryUser>>(new Map());
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const { users, loading, hasMore, loadMore } = useDirectory({
    query,
    notInGuild: guildId,
    pageSize: 20,
  });

  function toggle(user: DirectoryUser) {
    setResult(null);
    setPicked((previous) => {
      const next = new Map(previous);
      if (next.has(user.id)) next.delete(user.id);
      else if (next.size < SEND_INVITES_MAX) next.set(user.id, user);
      return next;
    });
  }

  async function send() {
    setSending(true);
    const response = await attempt(
      api.sendInvites(guildId, [...picked.keys()]),
      'Could not send the invites',
    );
    setSending(false);
    if (!response) return;
    const count = response.sent.length;
    setResult(`Invite sent to ${String(count)} ${count === 1 ? 'person' : 'people'}.`);
    setPicked(new Map());
  }

  return (
    <div className="invite-picker" data-harmony="invite-picker">
      <div className="directory-search">
        <SearchIcon width={18} height={18} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search people to invite"
          placeholder="Search people"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <ul className="invite-picker-list" aria-label="People to invite">
        {users.map((user) => {
          const checked = picked.has(user.id);
          return (
            <li key={user.id}>
              <button
                role="checkbox"
                aria-checked={checked}
                className="invite-picker-row"
                data-checked={checked || undefined}
                onClick={() => toggle(user)}
              >
                <Avatar user={user} size={32} />
                <span className="directory-names">
                  <span className="member-name">{user.displayName}</span>
                  <small>{user.login}</small>
                </span>
                <span className="invite-picker-check" aria-hidden="true">
                  {checked && <CheckIcon width={16} height={16} />}
                </span>
              </button>
            </li>
          );
        })}
        {users.length === 0 && !loading && (
          <li className="sidebar-empty">
            {query ? 'Nobody matches that search.' : 'Everyone is already in this server.'}
          </li>
        )}
      </ul>
      {hasMore && (
        <button className="button" disabled={loading} onClick={loadMore}>
          Show more
        </button>
      )}
      <div className="invite-picker-footer">
        <span role="status">{result ?? `${String(picked.size)} selected`}</span>
        <button
          className="button button-primary"
          disabled={picked.size === 0 || sending}
          onClick={() => void send()}
        >
          Send invite
        </button>
      </div>
    </div>
  );
}
