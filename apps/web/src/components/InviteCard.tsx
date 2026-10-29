import type { InvitePreview } from '@harmony/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/client.js';
import { useGuildBrand } from '../hooks/useGuildBrand.js';
import { guildPath } from '../lib/paths.js';
import { attempt, loadGuildChannels } from '../store/actions.js';
import { appStore, useApp } from '../store/store.js';
import { GuildIcon } from './Avatar.js';

type State =
  { status: 'loading' } | { status: 'ready'; preview: InvitePreview } | { status: 'gone' };

/** The guild behind an invite code, with a Join button; shown for invite messages in a DM. */
export function InviteCard({ code }: { code: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [joining, setJoining] = useState(false);
  const brand = useGuildBrand(state.status === 'ready' ? state.preview.guild.accentColor : null);
  const guildId = state.status === 'ready' ? state.preview.guild.id : null;
  // Joining anywhere (this card, the invite page, another card) flips the button.
  const joined = useApp((s) => (guildId !== null && s.guilds[guildId] !== undefined) || false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .invitePreview(code, controller.signal)
      .then((preview) => setState({ status: 'ready', preview }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'gone' });
      });
    return () => controller.abort();
  }, [code]);

  function open(id: string) {
    void navigate(guildPath(id, Object.values(appStore.getState().channels)));
  }

  async function join() {
    setJoining(true);
    const guild = await attempt(api.acceptInvite(code), 'Could not join the server');
    if (guild) {
      appStore.getState().upsertGuild(guild);
      await loadGuildChannels(guild.id);
    }
    setJoining(false);
  }

  if (state.status === 'loading') {
    return (
      <div className="invite-embed" data-harmony="invite-embed" role="status">
        Loading invite…
      </div>
    );
  }
  if (state.status === 'gone') {
    return (
      <div className="invite-embed" data-harmony="invite-embed" data-state="gone">
        <div className="invite-embed-text">
          <strong>Invite unavailable</strong>
          <small>It has expired or has no uses left.</small>
        </div>
      </div>
    );
  }

  const { guild, memberCount } = state.preview;
  const isMember = joined || state.preview.alreadyMember;
  return (
    <div className="invite-embed" data-harmony="invite-embed" style={brand}>
      <GuildIcon guild={guild} size={48} />
      <div className="invite-embed-text">
        <small>You have been invited to join</small>
        <strong>{guild.name}</strong>
        <small>
          {memberCount} {memberCount === 1 ? 'member' : 'members'}
        </small>
      </div>
      {isMember ? (
        <div className="invite-embed-actions">
          <span className="invite-embed-joined">Joined</span>
          <button className="button" onClick={() => open(guild.id)}>
            Open
          </button>
        </div>
      ) : (
        <button className="button button-primary" disabled={joining} onClick={() => void join()}>
          Join
        </button>
      )}
    </div>
  );
}
