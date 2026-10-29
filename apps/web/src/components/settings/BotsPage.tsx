import { BOT_NAME_MAX, type Bot } from '@harmony/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api/client.js';
import { attempt, reportError } from '../../store/actions.js';
import { Avatar } from '../Avatar.js';
import { ChevronRightIcon, PlusIcon } from '../Icons.js';
import { Modal } from '../Overlay.js';
import { SecretsView, type Secret } from './SecretsView.js';
import { SettingsPage } from './SettingsLayout.js';

function CreateBotDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; secrets: Secret[] } | null>(null);
  const navigate = useNavigate();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await attempt(api.createBot({ name: name.trim() }), 'Could not create the bot');
    setBusy(false);
    if (!result) return;
    setCreated({
      id: result.bot.id,
      secrets: [
        {
          label: 'Bot token',
          value: result.token,
          hint: 'Send it as "Authorization: Bot <token>".',
        },
        {
          label: 'Signing secret',
          value: result.signingSecret,
          hint: 'Verify the signature on requests Harmony makes to your bot.',
        },
      ],
    });
  }

  function close() {
    const id = created?.id;
    setCreated(null);
    setName('');
    onOpenChange(false);
    if (id) void navigate(`/settings/user/bots/${id}`);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={created ? 'Bot created' : 'Create a bot'}
      description={
        created
          ? 'These credentials are shown only now.'
          : 'Bots are accounts your own code signs in as. Scopes and URLs come next.'
      }
    >
      {created ? (
        <SecretsView secrets={created.secrets} onDone={close} />
      ) : (
        <form className="form" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span>Bot name</span>
            <input
              autoFocus
              required
              maxLength={BOT_NAME_MAX}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Deploy helper"
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="button" onClick={close}>
              Cancel
            </button>
            <button className="button button-primary" disabled={busy || !name.trim()}>
              Create bot
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function BotsPage() {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .bots(controller.signal)
      .then(setBots)
      .catch((error: unknown) => reportError(error, 'Could not load your bots'));
    return () => controller.abort();
  }, []);

  return (
    <SettingsPage title="My bots" back="/settings/user">
      <p className="settings-lead">
        A bot is an account for your own code: it can read and send messages, react, answer slash
        commands and receive signed events. Add a bot to a server from that server&apos;s settings.
      </p>
      <div className="settings-toolbar">
        <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
          <PlusIcon width={18} height={18} /> Create bot
        </button>
      </div>
      {bots === null ? (
        <p className="empty-note" role="status">
          Loading…
        </p>
      ) : bots.length === 0 ? (
        <p className="empty-note">You have no bots yet.</p>
      ) : (
        <ul className="settings-list" aria-label="Your bots">
          {bots.map((bot) => (
            <li key={bot.id}>
              <Link to={`/settings/user/bots/${bot.id}`} className="settings-row settings-row-link">
                <Avatar
                  user={{ id: bot.id, displayName: bot.name, avatarUrl: bot.avatarUrl }}
                  size={40}
                />
                <span className="settings-row-text">
                  <span className="settings-row-title">{bot.name}</span>
                  <span className="settings-row-meta">
                    {bot.scopes.length} {bot.scopes.length === 1 ? 'scope' : 'scopes'}
                    {bot.delivery.interactions === 'off' ? '' : ' · slash commands'}
                    {bot.delivery.events === 'off' ? '' : ' · events'}
                    {bot.delivery.interactions === 'gateway' || bot.delivery.events === 'gateway'
                      ? ' · gateway'
                      : ''}
                  </span>
                </span>
                <ChevronRightIcon width={18} height={18} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <CreateBotDialog open={creating} onOpenChange={setCreating} />
    </SettingsPage>
  );
}
