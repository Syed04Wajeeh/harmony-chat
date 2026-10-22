import { MAX_GUILD_DESCRIPTION_LENGTH, MAX_GUILD_NAME_LENGTH } from '@harmony/shared';
import { useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, uploadFile } from '../../api/client.js';
import { useGuildBrand } from '../../hooks/useGuildBrand.js';
import { ACCENT_SWATCHES } from '../../lib/themeEditor.js';
import { parseHex, toHex } from '../../lib/roleColor.js';
import { attempt } from '../../store/actions.js';
import { appStore, useApp } from '../../store/store.js';
import { GuildIcon } from '../Avatar.js';
import { ConfirmDialog } from '../Overlay.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

/** What members see in the sidebar and on the invite page, with the accent applied. */
function BrandingPreview({
  name,
  accent,
  bannerUrl,
  description,
}: {
  name: string;
  accent: number | null;
  bannerUrl: string | null;
  description: string;
}) {
  const style = useGuildBrand(accent, true);
  return (
    <div className="branding-preview" style={style} role="group" aria-label="Preview">
      <div className="branding-sidebar">
        {bannerUrl && (
          <div className="sidebar-banner">
            <img src={bannerUrl} alt="" />
          </div>
        )}
        <div className="sidebar-header" data-banner={bannerUrl ? '' : undefined}>
          <h2>{name || 'Server name'}</h2>
        </div>
        <div className="channel-link" aria-current="page">
          <span className="channel-name"># general</span>
        </div>
        <div className="channel-link">
          <span className="channel-name"># random</span>
        </div>
      </div>
      <div className="branding-invite">
        <strong>{name || 'Server name'}</strong>
        {description && <p>{description}</p>}
        <span className="button button-primary">Accept invite</span>
      </div>
    </div>
  );
}

export function OverviewPage() {
  const { guildId = '' } = useParams();
  const guild = useApp((state) => state.guilds[guildId]);
  const meId = useApp((state) => state.me?.id);
  const picker = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [name, setName] = useState(guild?.name ?? '');
  const [description, setDescription] = useState(guild?.description ?? '');
  const [accent, setAccent] = useState<number | null>(guild?.accentColor ?? null);
  const banner = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!guild) return null;
  const changed =
    name.trim() !== guild.name ||
    description.trim() !== (guild.description ?? '') ||
    accent !== guild.accentColor;

  async function update(body: Parameters<typeof api.updateGuild>[1]) {
    setBusy(true);
    const updated = await attempt(api.updateGuild(guildId, body), 'Could not save changes');
    if (updated) appStore.getState().upsertGuild(updated);
    setBusy(false);
    return updated;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await update({ name: name.trim(), description: description.trim(), accentColor: accent });
  }

  async function chooseBanner(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    const attachment = await attempt(uploadFile(file), 'Could not upload the banner');
    setBusy(false);
    if (attachment) await update({ bannerAttachmentId: attachment.id });
  }

  async function chooseIcon(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    const attachment = await attempt(uploadFile(file), 'Could not upload the icon');
    setBusy(false);
    if (attachment) await update({ iconAttachmentId: attachment.id });
  }

  async function remove() {
    const deleted = await attempt(
      api.deleteGuild(guildId).then(() => true),
      'Could not delete',
    );
    if (deleted) void navigate('/');
  }

  return (
    <SettingsPage title="Overview" back={`/settings/server/${guildId}`}>
      <SettingsCard title="Server">
        <form className="form" onSubmit={(event) => void save(event)}>
          <div className="icon-editor">
            <GuildIcon guild={guild} size={72} />
            <div className="icon-editor-actions">
              <input
                ref={picker}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={(event) => {
                  void chooseIcon(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              <button type="button" className="button" onClick={() => picker.current?.click()}>
                Upload icon
              </button>
              {guild.iconUrl && (
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => void update({ iconAttachmentId: null })}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
          <label className="field">
            <span>Server name</span>
            <input
              required
              maxLength={MAX_GUILD_NAME_LENGTH}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea
              rows={3}
              maxLength={MAX_GUILD_DESCRIPTION_LENGTH}
              value={description}
              placeholder="Shown on the invite page"
              onChange={(event) => setDescription(event.target.value)}
            />
            <small className="field-hint">
              {description.length} of {MAX_GUILD_DESCRIPTION_LENGTH}
            </small>
          </label>
          <div className="field">
            <span>Accent color</span>
            <div className="swatches" role="group" aria-label="Accent color">
              {ACCENT_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className="swatch"
                  style={{ background: hex }}
                  aria-label={`Accent ${hex}`}
                  aria-pressed={accent === parseHex(hex)}
                  onClick={() => setAccent(parseHex(hex))}
                />
              ))}
              <label className="swatch swatch-custom">
                <input
                  type="color"
                  aria-label="Custom accent color"
                  value={toHex(accent ?? 0x5fb89a)}
                  onChange={(event) => setAccent(parseHex(event.target.value))}
                />
              </label>
              {accent !== null && (
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setAccent(null)}
                >
                  Clear
                </button>
              )}
            </div>
            <small className="field-hint">
              Members who allow it see the app in this color while the server is open. It is
              adjusted so text stays readable on their theme.
            </small>
          </div>
          <div className="modal-actions">
            <button className="button button-primary" disabled={busy || !name.trim() || !changed}>
              Save
            </button>
          </div>
        </form>
      </SettingsCard>
      <SettingsCard
        title="Banner"
        description="Shown above the channel list and on invite pages. Wide images work best."
      >
        <input
          ref={banner}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(event) => {
            void chooseBanner(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <div className="modal-actions">
          {guild.bannerUrl && (
            <button
              type="button"
              className="button button-ghost"
              onClick={() => void update({ bannerAttachmentId: null })}
            >
              Remove banner
            </button>
          )}
          <button type="button" className="button" onClick={() => banner.current?.click()}>
            Upload banner
          </button>
        </div>
      </SettingsCard>
      <SettingsCard title="Preview">
        <BrandingPreview
          name={name}
          accent={accent}
          bannerUrl={guild.bannerUrl}
          description={description}
        />
      </SettingsCard>
      {guild.ownerId === meId && (
        <SettingsCard
          title="Delete server"
          description="All channels and messages in this server are permanently deleted for everyone."
          danger
        >
          <button
            type="button"
            className="button button-danger-outline"
            onClick={() => setConfirmDelete(true)}
          >
            Delete server
          </button>
        </SettingsCard>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${guild.name}?`}
        description="All channels and messages in this server will be permanently deleted for everyone."
        confirmLabel="Delete server"
        danger
        onConfirm={() => void remove()}
      />
    </SettingsPage>
  );
}
