import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../api/client.js';
import { GuildIcon } from '../components/Avatar.js';
import { Toasts } from '../components/Toasts.js';
import { useGuildBrand } from '../hooks/useGuildBrand.js';
import { guildPath } from '../lib/paths.js';
import { attempt, loadGuildChannels } from '../store/actions.js';
import { appStore } from '../store/store.js';
import type { InvitePreview } from '@harmony/shared';

type State =
  | { status: 'loading' }
  | { status: 'ready'; preview: InvitePreview }
  | { status: 'error'; message: string };

export function InvitePage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [joining, setJoining] = useState(false);
  const brand = useGuildBrand(state.status === 'ready' ? state.preview.guild.accentColor : null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .invitePreview(code, controller.signal)
      .then((preview) => setState({ status: 'ready', preview }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          error instanceof ApiError && error.code === 'invite_not_found'
            ? 'This invite link is not valid.'
            : error instanceof ApiError && error.code === 'invite_expired'
              ? 'This invite has expired or has no uses left.'
              : 'Could not load this invite.';
        setState({ status: 'error', message });
      });
    return () => controller.abort();
  }, [code]);

  async function accept() {
    setJoining(true);
    const guild = await attempt(api.acceptInvite(code), 'Could not join the server');
    if (guild) {
      appStore.getState().upsertGuild(guild);
      await loadGuildChannels(guild.id);
      void navigate(guildPath(guild.id, Object.values(appStore.getState().channels)), {
        replace: true,
      });
    }
    setJoining(false);
  }

  return (
    <main className="invite-page">
      <div className="invite-card" style={brand} data-harmony="invite-card">
        {state.status === 'loading' && <p role="status">Loading invite…</p>}
        {state.status === 'error' && (
          <>
            <h1>Invite unavailable</h1>
            <p>{state.message}</p>
            <button className="button" onClick={() => void navigate('/', { replace: true })}>
              Back to Harmony
            </button>
          </>
        )}
        {state.status === 'ready' && (
          <>
            {state.preview.guild.bannerUrl && (
              <div className="invite-banner" data-harmony="guild-banner">
                <img src={state.preview.guild.bannerUrl} alt="" />
              </div>
            )}
            <GuildIcon guild={state.preview.guild} size={80} />
            <p className="invite-eyebrow">You have been invited to join</p>
            <h1>{state.preview.guild.name}</h1>
            {state.preview.guild.description && (
              <p className="invite-description">{state.preview.guild.description}</p>
            )}
            <p className="invite-meta">
              {state.preview.memberCount} {state.preview.memberCount === 1 ? 'member' : 'members'}
            </p>
            {state.preview.alreadyMember ? (
              <button
                className="button button-primary invite-action"
                onClick={() =>
                  void navigate(
                    guildPath(state.preview.guild.id, Object.values(appStore.getState().channels)),
                    { replace: true },
                  )
                }
              >
                Open server
              </button>
            ) : (
              <button
                className="button button-primary invite-action"
                disabled={joining}
                onClick={() => void accept()}
              >
                Accept invite
              </button>
            )}
          </>
        )}
      </div>
      <Toasts />
    </main>
  );
}
