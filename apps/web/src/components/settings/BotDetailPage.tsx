import {
  BOT_NAME_MAX,
  BOT_SCOPES,
  EVENT_TYPES,
  type Bot,
  type BotScope,
  type EventType,
} from '@harmony/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../../api/client.js';
import { describeError } from '../../lib/errors.js';
import { attempt, reportError } from '../../store/actions.js';
import { useUi } from '../../store/ui.js';
import { ConfirmDialog } from '../Overlay.js';
import { BotCommands } from './BotCommands.js';
import { DeliveryLog } from './DeliveryLog.js';
import { EVENT_INFO, SCOPE_INFO } from './scopes.js';
import { SecretsDialog, type Secret } from './SecretsView.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

interface Draft {
  name: string;
  scopes: BotScope[];
  interactionsUrl: string;
  eventsUrl: string;
  eventTypes: EventType[];
}

const toDraft = (bot: Bot): Draft => ({
  name: bot.name,
  scopes: bot.scopes,
  interactionsUrl: bot.interactionsUrl ?? '',
  eventsUrl: bot.eventsUrl ?? '',
  eventTypes: bot.eventTypes,
});

const sameSet = <T,>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

function isDirty(bot: Bot, draft: Draft): boolean {
  const saved = toDraft(bot);
  return (
    draft.name.trim() !== saved.name ||
    draft.interactionsUrl.trim() !== saved.interactionsUrl ||
    draft.eventsUrl.trim() !== saved.eventsUrl ||
    !sameSet(draft.scopes, saved.scopes) ||
    !sameSet(draft.eventTypes, saved.eventTypes)
  );
}

function toggle<T>(list: readonly T[], item: T, on: boolean): T[] {
  return on
    ? [...list.filter((entry) => entry !== item), item]
    : list.filter((entry) => entry !== item);
}

export function BotDetailPage() {
  const { botId = '' } = useParams();
  const [bot, setBot] = useState<Bot | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .bot(botId, controller.signal)
      .then(setBot)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) setMissing(true);
        else reportError(error, 'Could not load the bot');
      });
    return () => controller.abort();
  }, [botId]);

  if (missing) return <Navigate replace to="/settings/user/bots" />;
  return (
    <SettingsPage title={bot?.name ?? 'Bot'} back="/settings/user/bots">
      {bot === null ? (
        <p className="empty-note" role="status">
          Loading…
        </p>
      ) : (
        <BotEditor key={bot.id} bot={bot} onSaved={setBot} />
      )}
    </SettingsPage>
  );
}

function BotEditor({ bot, onSaved }: { bot: Bot; onSaved: (bot: Bot) => void }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(() => toDraft(bot));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [secrets, setSecrets] = useState<{ title: string; items: Secret[] } | null>(null);
  const [confirm, setConfirm] = useState<'token' | 'secret' | 'delete' | null>(null);

  const hasCommands = draft.scopes.includes('commands');
  const hasEvents = draft.scopes.includes('events');
  const dirty = isDirty(bot, draft);
  const set = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const interactionsUrl = hasCommands ? draft.interactionsUrl.trim() : '';
      const eventsUrl = hasEvents ? draft.eventsUrl.trim() : '';
      const updated = await api.updateBot(bot.id, {
        name: draft.name.trim(),
        scopes: draft.scopes,
        interactionsUrl: interactionsUrl || null,
        eventsUrl: eventsUrl || null,
        eventTypes: hasEvents ? draft.eventTypes : [],
      });
      onSaved(updated);
      setDraft(toDraft(updated));
      useUi.getState().pushToast('Bot saved', 'info');
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? describeError(failure.code, failure.message)
          : 'Could not save the bot',
      );
    } finally {
      setSaving(false);
    }
  }

  async function rotate(kind: 'token' | 'secret') {
    setConfirm(null);
    if (kind === 'token') {
      const token = await attempt(api.rotateBotToken(bot.id), 'Could not rotate the token');
      if (token) {
        setSecrets({
          title: 'New bot token',
          items: [
            { label: 'Bot token', value: token, hint: 'The previous token no longer works.' },
          ],
        });
      }
    } else {
      const value = await attempt(api.rotateSigningSecret(bot.id), 'Could not rotate the secret');
      if (value) {
        setSecrets({
          title: 'New signing secret',
          items: [{ label: 'Signing secret', value, hint: 'It signs every request from now on.' }],
        });
      }
    }
  }

  async function remove() {
    setConfirm(null);
    const removed = await attempt(
      api.deleteBot(bot.id).then(() => true),
      'Could not delete the bot',
    );
    if (removed) {
      useUi.getState().pushToast(`Deleted ${bot.name}`, 'info');
      void navigate('/settings/user/bots');
    }
  }

  return (
    <>
      <form className="settings-form" onSubmit={(event) => void save(event)}>
        <SettingsCard title="General">
          <label className="field">
            <span>Bot name</span>
            <input
              required
              maxLength={BOT_NAME_MAX}
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
            />
          </label>
        </SettingsCard>

        <SettingsCard
          title="Scopes"
          description="What this bot's token may do. Turn on only what it needs."
        >
          <ul className="check-list">
            {BOT_SCOPES.map((scope) => (
              <li key={scope}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={draft.scopes.includes(scope)}
                    onChange={(event) =>
                      set({ scopes: toggle(draft.scopes, scope, event.target.checked) })
                    }
                  />
                  <span>
                    <strong>{SCOPE_INFO[scope].label}</strong>
                    <small>{SCOPE_INFO[scope].description}</small>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </SettingsCard>

        <SettingsCard
          title="Interactions URL"
          description="Harmony sends slash command and button invocations here as signed POST requests. Leave it empty for a bot that connects out instead."
        >
          <label className="field">
            <span>URL</span>
            <input
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              aria-label="Interactions URL"
              placeholder="https://bot.example.com/interactions"
              disabled={!hasCommands}
              value={draft.interactionsUrl}
              onChange={(event) => set({ interactionsUrl: event.target.value })}
            />
          </label>
          {!hasCommands ? (
            <p className="field-hint">
              Turn on the Slash commands scope to set an interactions URL.
            </p>
          ) : (
            <p className="field-hint" data-testid="interactions-mode">
              {draft.interactionsUrl.trim()
                ? 'Delivery: HTTP. Harmony calls this URL.'
                : 'Delivery: gateway. The bot receives interactions over its WebSocket connection (Authorization: Bot) and needs no URL.'}
            </p>
          )}
        </SettingsCard>

        <SettingsCard
          title="Events URL"
          description="Selected events are delivered here, signed, at least once. Leave it empty for a bot that connects out instead."
        >
          <label className="field">
            <span>URL</span>
            <input
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              aria-label="Events URL"
              placeholder="https://bot.example.com/events"
              disabled={!hasEvents}
              value={draft.eventsUrl}
              onChange={(event) => set({ eventsUrl: event.target.value })}
            />
          </label>
          {!hasEvents ? (
            <p className="field-hint">Turn on the Events scope to set an events URL.</p>
          ) : (
            <p className="field-hint" data-testid="events-mode">
              {draft.eventsUrl.trim()
                ? 'Delivery: HTTP. Harmony calls this URL.'
                : "Delivery: gateway. Events arrive as numbered frames on the bot's WebSocket connection; it acknowledges them and resumes after a disconnect."}
            </p>
          )}
          <fieldset className="check-fieldset" disabled={!hasEvents}>
            <legend>Event types</legend>
            <ul className="check-list">
              {EVENT_TYPES.map((type) => (
                <li key={type}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={draft.eventTypes.includes(type)}
                      onChange={(event) =>
                        set({ eventTypes: toggle(draft.eventTypes, type, event.target.checked) })
                      }
                    />
                    <span>
                      <code>{type}</code>
                      <small>{EVENT_INFO[type]}</small>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        </SettingsCard>

        <div className="save-bar">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button button-primary"
            disabled={saving || !dirty || !draft.name.trim()}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>

      <SettingsCard
        title="Credentials"
        description="Secrets are shown once and cannot be read back. Rotating replaces the old value immediately."
      >
        <div className="credential-rows">
          <div className="settings-row">
            <span className="settings-row-text">
              <span className="settings-row-title">Bot token</span>
              <span className="settings-row-meta">
                {bot.lastUsedAt
                  ? `Last used ${new Date(bot.lastUsedAt).toLocaleString()}`
                  : 'Never used'}
              </span>
            </span>
            <button type="button" className="button" onClick={() => setConfirm('token')}>
              Rotate token
            </button>
          </div>
          <div className="settings-row">
            <span className="settings-row-text">
              <span className="settings-row-title">Signing secret</span>
              <span className="settings-row-meta">Verifies requests Harmony sends to your bot</span>
            </span>
            <button type="button" className="button" onClick={() => setConfirm('secret')}>
              Rotate secret
            </button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Registered commands"
        description="Slash commands this bot has registered."
      >
        <BotCommands botId={bot.id} />
      </SettingsCard>

      <SettingsCard
        title="Event deliveries"
        description="Every event sent to the events URL, with its retry state. Records are kept for 7 days."
      >
        <DeliveryLog botId={bot.id} />
      </SettingsCard>

      <SettingsCard
        title="Delete bot"
        description="Revokes its token, removes it from every server and deletes its commands. Its past messages stay."
        danger
      >
        <button
          type="button"
          className="button button-danger-outline"
          onClick={() => setConfirm('delete')}
        >
          Delete bot
        </button>
      </SettingsCard>

      <SecretsDialog
        title={secrets?.title ?? ''}
        secrets={secrets?.items ?? null}
        onClose={() => setSecrets(null)}
      />
      <ConfirmDialog
        open={confirm === 'token'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Rotate the bot token?"
        description="The current token stops working immediately. Anything still using it will get 401 errors until you update it."
        confirmLabel="Rotate token"
        danger
        onConfirm={() => void rotate('token')}
      />
      <ConfirmDialog
        open={confirm === 'secret'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Rotate the signing secret?"
        description="New requests are signed with the new secret straight away. Your bot must verify with it, or it will reject Harmony's requests."
        confirmLabel="Rotate secret"
        danger
        onConfirm={() => void rotate('secret')}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Delete ${bot.name}?`}
        description="This cannot be undone."
        confirmLabel="Delete bot"
        danger
        onConfirm={() => void remove()}
      />
    </>
  );
}
