import {
  WebhookName,
  type ChannelSummary,
  type Webhook,
  type WebhookFormat,
} from '@harmony/shared';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { api, uploadFile } from '../../api/client.js';
import { attempt } from '../../store/actions.js';
import { guildChannels } from '../../store/selectors.js';
import { useApp } from '../../store/store.js';
import { Avatar } from '../Avatar.js';
import { EditIcon, HashIcon, LockIcon, PlusIcon, TrashIcon } from '../Icons.js';
import { ConfirmDialog, Modal } from '../Overlay.js';
import { FORMAT_INFO, STARTER_TEMPLATE, WEBHOOK_FORMAT_ORDER } from '../../lib/webhook-formats.js';
import { DocLinks } from './DocLinks.js';
import { SecretsView } from './SecretsView.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';
import { WebhookEditor } from './WebhookEditor.js';

type CreatedWebhook = Awaited<ReturnType<typeof api.createWebhook>>;

const IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp';

/** The public origin plus the one-time path the server returns. */
export const webhookUrl = (path: string, origin = window.location.origin): string =>
  new URL(path, origin).href;

function CreateWebhookDialog({
  channels,
  initialChannelId,
  open,
  onOpenChange,
  onCreated,
}: {
  channels: readonly ChannelSummary[];
  initialChannelId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (webhook: Webhook) => void;
}) {
  const [channelId, setChannelId] = useState(initialChannelId ?? '');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<File | null>(null);
  const [format, setFormat] = useState<WebhookFormat>('discord');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedWebhook | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const target = channelId || initialChannelId || '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    let avatarAttachmentId: string | undefined;
    if (avatar) {
      const upload = await attempt(uploadFile(avatar), 'Could not upload the avatar');
      if (!upload) return setBusy(false);
      avatarAttachmentId = upload.id;
    }
    const webhook = await attempt(
      api.createWebhook(target, {
        name: name.trim(),
        ...(avatarAttachmentId && { avatarAttachmentId }),
        ...(format !== 'discord' && { format }),
        // A template webhook starts from an example; the editor changes it.
        ...(format === 'template' && { template: STARTER_TEMPLATE }),
      }),
      'Could not create the webhook',
    );
    setBusy(false);
    if (webhook) {
      setCreated(webhook);
      onCreated(webhook);
    }
  }

  function close() {
    setCreated(null);
    setName('');
    setAvatar(null);
    onOpenChange(false);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={created ? 'Webhook created' : 'Create a webhook'}
      description={
        created
          ? 'Paste this URL into the tool that will post here.'
          : 'Anything that can send a POST request can post to a channel with it.'
      }
    >
      {created ? (
        <SecretsView
          secrets={[
            {
              label: 'Webhook URL',
              value: webhookUrl(created.url),
              hint: 'Anyone with this URL can post to the channel, so treat it like a password.',
            },
          ]}
          onDone={close}
        />
      ) : (
        <form className="form" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span>Channel</span>
            <select value={target} onChange={(event) => setChannelId(event.target.value)}>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  #{channel.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Name</span>
            <input
              required
              autoFocus
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Uptime Kuma"
            />
          </label>
          <label className="field">
            <span>Format</span>
            <select
              value={format}
              onChange={(event) => setFormat(event.target.value as WebhookFormat)}
            >
              {WEBHOOK_FORMAT_ORDER.map((value) => (
                <option key={value} value={value}>
                  {FORMAT_INFO[value].label}
                </option>
              ))}
            </select>
            <small className="field-hint">{FORMAT_INFO[format].hint}</small>
          </label>
          <div className="field">
            <span>Avatar (optional)</span>
            <div className="icon-editor">
              <Avatar
                user={{ id: target, displayName: name || 'Webhook', avatarUrl: null }}
                size={48}
              />
              <input
                ref={picker}
                type="file"
                accept={IMAGE_TYPES}
                hidden
                aria-label="Webhook avatar"
                onChange={(event) => setAvatar(event.target.files?.[0] ?? null)}
              />
              <button type="button" className="button" onClick={() => picker.current?.click()}>
                {avatar ? avatar.name : 'Upload image'}
              </button>
              {avatar && (
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setAvatar(null)}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="button" onClick={close}>
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={busy || !target || !WebhookName.safeParse(name).success}
            >
              Create webhook
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function IntegrationsPage() {
  const { guildId = '' } = useParams();
  const channelMap = useApp((state) => state.channels);
  const channels = useMemo(
    () => guildChannels(Object.values(channelMap), guildId),
    [channelMap, guildId],
  );
  const channelKey = channels.map((channel) => channel.id).join(',');
  const [byChannel, setByChannel] = useState<Record<string, Webhook[]> | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const [editing, setEditing] = useState<Webhook | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const ids = channelKey ? channelKey.split(',') : [];
    void Promise.all(
      ids.map((id) =>
        // A channel this person cannot see answers 403; it simply has no row here.
        api.webhooks(id, controller.signal).then(
          (list) => [id, list] as const,
          () => [id, [] as Webhook[]] as const,
        ),
      ),
    ).then((entries) => {
      if (!controller.signal.aborted) setByChannel(Object.fromEntries(entries));
    });
    return () => controller.abort();
  }, [channelKey]);

  const addLocally = (webhook: Webhook) =>
    setByChannel((current) => ({
      ...current,
      [webhook.channelId]: [...(current?.[webhook.channelId] ?? []), webhook],
    }));

  const replaceLocally = (webhook: Webhook) =>
    setByChannel((current) => ({
      ...current,
      [webhook.channelId]: (current?.[webhook.channelId] ?? []).map((w) =>
        w.id === webhook.id ? webhook : w,
      ),
    }));

  async function remove(webhook: Webhook) {
    setDeleting(null);
    const deleted = await attempt(
      api.deleteWebhook(webhook.id).then(() => true),
      'Could not delete the webhook',
    );
    if (deleted) {
      setByChannel((current) => ({
        ...current,
        [webhook.channelId]: (current?.[webhook.channelId] ?? []).filter(
          (w) => w.id !== webhook.id,
        ),
      }));
    }
  }

  const withWebhooks = channels.filter((channel) => (byChannel?.[channel.id]?.length ?? 0) > 0);

  return (
    <SettingsPage title="Integrations" back={`/settings/server/${guildId}`}>
      <SettingsCard
        title="Incoming webhooks"
        description="A webhook gives a tool a URL to post messages into one channel. Discord-style payloads work as they are, and presets or a template turn other services' JSON into messages."
      >
        <DocLinks />
        <div className="settings-toolbar">
          <button
            type="button"
            className="button button-primary"
            disabled={channels.length === 0}
            onClick={() => setCreating(true)}
          >
            <PlusIcon width={18} height={18} /> Create webhook
          </button>
        </div>
        {byChannel === null ? (
          <p className="empty-note" role="status">
            Loading…
          </p>
        ) : withWebhooks.length === 0 ? (
          <p className="empty-note">No webhooks in this server yet.</p>
        ) : (
          withWebhooks.map((channel) => (
            <div key={channel.id} className="webhook-group">
              <h3 className="settings-subheading">
                {channel.isPrivate ? (
                  <LockIcon width={16} height={16} />
                ) : (
                  <HashIcon width={16} height={16} />
                )}
                {channel.name}
              </h3>
              <ul className="settings-list" aria-label={`Webhooks in ${channel.name ?? 'channel'}`}>
                {(byChannel[channel.id] ?? []).map((webhook) => (
                  <li key={webhook.id} className="settings-row">
                    <Avatar
                      user={{
                        id: webhook.id,
                        displayName: webhook.name,
                        avatarUrl: webhook.avatarUrl,
                      }}
                      size={40}
                    />
                    <span className="settings-row-text">
                      <span className="settings-row-title">{webhook.name}</span>
                      <span className="settings-row-meta">
                        {FORMAT_INFO[webhook.format].label} · Created{' '}
                        {new Date(webhook.createdAt).toLocaleDateString()}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Edit webhook ${webhook.name}`}
                      onClick={() => setEditing(webhook)}
                    >
                      <EditIcon />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Delete webhook ${webhook.name}`}
                      onClick={() => setDeleting(webhook)}
                    >
                      <TrashIcon />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </SettingsCard>
      <CreateWebhookDialog
        key={String(creating)}
        channels={channels}
        initialChannelId={channels.find((c) => c.name === 'general')?.id ?? channels[0]?.id}
        open={creating}
        onOpenChange={setCreating}
        onCreated={addLocally}
      />
      {editing && (
        <WebhookEditor
          key={editing.id}
          webhook={editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={replaceLocally}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'webhook'}?`}
        description="Tools using its URL stop working. Messages it already posted stay."
        confirmLabel="Delete webhook"
        danger
        onConfirm={() => deleting && void remove(deleting)}
      />
    </SettingsPage>
  );
}
