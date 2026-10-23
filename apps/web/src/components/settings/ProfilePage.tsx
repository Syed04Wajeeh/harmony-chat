import {
  MAX_BIO_LENGTH,
  MAX_PRONOUNS_LENGTH,
  numberToHex,
  parseHexNumber,
  type UserProfileResponse,
} from '@harmony/shared';
import { useEffect, useRef, useState } from 'react';
import { api, uploadFile } from '../../api/client.js';
import { profileStyle } from '../../lib/profileColor.js';
import { attempt } from '../../store/actions.js';
import { useProfiles } from '../../store/profiles.js';
import { useApp } from '../../store/store.js';
import { Avatar } from '../Avatar.js';
import { EmojiValue } from '../Emoji.js';
import { Markdown } from '../Markdown.js';
import { PerkBadge } from '../PerkBadge.js';
import { AvatarCropDialog } from './AvatarCropDialog.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

const isAnimatedType = (file: File) => file.type === 'image/gif' || file.type === 'image/webp';

export function ProfilePage() {
  const me = useApp((state) => state.me);
  const perks = useProfiles((state) => state.perks);
  const version = useProfiles((state) => state.versions[me?.id ?? ''] ?? 0);
  const [data, setData] = useState<UserProfileResponse | null>(null);
  const [bio, setBio] = useState('');
  const [pronouns, setPronouns] = useState('');
  const [accent, setAccent] = useState('');
  const [bannerColor, setBannerColor] = useState('');
  const [cropping, setCropping] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!me) return;
    void api.profile(me.id).then((loaded) => {
      setData(loaded);
      setBio(loaded.profile.bio ?? '');
      setPronouns(loaded.profile.pronouns ?? '');
      setAccent(loaded.profile.accentColor === null ? '' : numberToHex(loaded.profile.accentColor));
      setBannerColor(
        loaded.profile.bannerColor === null ? '' : numberToHex(loaded.profile.bannerColor),
      );
    });
  }, [me, version]);
  if (!me || !data)
    return (
      <SettingsPage title="Profile" back="/settings/user">
        {null}
      </SettingsPage>
    );

  const profile = data.profile;
  const accentNumber = parseHexNumber(accent);
  const bannerNumber = parseHexNumber(bannerColor);

  async function save(patch: Parameters<typeof api.updateProfile>[0]) {
    setSaving(true);
    await attempt(api.updateProfile(patch), 'Could not save your profile');
    setSaving(false);
  }

  async function uploadAvatar(blob: Blob | File, name: string) {
    const attachment = await attempt(
      uploadFile(new File([blob], name, { type: blob.type })),
      'Could not upload the picture',
    );
    if (attachment) await save({ avatarAttachmentId: attachment.id });
  }

  async function chooseAvatar(file: File) {
    // Animated images keep their frames, so they skip the canvas crop (which would flatten them).
    if (isAnimatedType(file)) await uploadAvatar(file, file.name);
    else setCropping(file);
  }

  async function chooseBanner(file: File) {
    const attachment = await attempt(uploadFile(file), 'Could not upload the banner');
    if (attachment) await save({ bannerAttachmentId: attachment.id });
  }

  return (
    <SettingsPage title="Profile" back="/settings/user">
      <p className="settings-lead">How other people see you. Saved to your account.</p>
      <div className="profile-editor">
        <div className="profile-editor-forms">
          <SettingsCard title="Picture">
            <div className="profile-picture-row">
              <Avatar user={{ ...me, avatarUrl: profile.avatarUrl }} size={64} />
              <div className="profile-picture-actions">
                <button className="button" onClick={() => avatarInput.current?.click()}>
                  Upload a picture
                </button>
                {profile.avatarOverridden && (
                  <button
                    className="button"
                    onClick={() => void save({ avatarAttachmentId: null })}
                  >
                    Reset to Tailscale picture
                  </button>
                )}
                {!perks.has('animated_avatar') && (
                  <p className="field-hint">
                    Animated GIF or WebP avatars <PerkBadge perk="animated_avatar" />
                  </p>
                )}
              </div>
              <input
                ref={avatarInput}
                type="file"
                hidden
                accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void chooseAvatar(file);
                }}
              />
            </div>
          </SettingsCard>
          <SettingsCard title="Banner" description="A color, or an image if you have the perk.">
            <label className="field">
              <span>Banner color</span>
              <input
                aria-label="Banner color"
                placeholder="#5865f2"
                value={bannerColor}
                onChange={(event) => setBannerColor(event.target.value)}
                onBlur={() => bannerNumber !== null && void save({ bannerColor: bannerNumber })}
              />
            </label>
            <div className="profile-picture-actions">
              <button
                className="button"
                disabled={!perks.has('profile_banner_image')}
                onClick={() => bannerInput.current?.click()}
              >
                Upload a banner image
              </button>
              {!perks.has('profile_banner_image') && <PerkBadge perk="profile_banner_image" />}
              {profile.bannerUrl && (
                <button className="button" onClick={() => void save({ bannerAttachmentId: null })}>
                  Remove image
                </button>
              )}
            </div>
            <input
              ref={bannerInput}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void chooseBanner(file);
              }}
            />
          </SettingsCard>
          <SettingsCard title="About you">
            <label className="field">
              <span>Accent color</span>
              <input
                aria-label="Accent color"
                placeholder="#5865f2"
                value={accent}
                onChange={(event) => setAccent(event.target.value)}
                onBlur={() => accentNumber !== null && void save({ accentColor: accentNumber })}
              />
            </label>
            <label className="field">
              <span>Pronouns</span>
              <input
                maxLength={MAX_PRONOUNS_LENGTH}
                value={pronouns}
                onChange={(event) => setPronouns(event.target.value)}
                onBlur={() => void save({ pronouns: pronouns.trim() || null })}
              />
            </label>
            <label className="field">
              <span>
                Bio{' '}
                <small>
                  {bio.length}/{MAX_BIO_LENGTH}
                </small>
              </span>
              <textarea
                rows={4}
                maxLength={MAX_BIO_LENGTH}
                value={bio}
                onChange={(event) => setBio(event.target.value)}
                onBlur={() => void save({ bio: bio.trim() || null })}
              />
            </label>
            {saving && <p className="field-hint">Saving…</p>}
          </SettingsCard>
        </div>
        <aside className="profile-editor-preview" aria-label="Preview">
          <h2 className="profile-preview-title">Preview</h2>
          <div className="profile-card" style={profileStyle(accentNumber ?? profile.accentColor)}>
            <div
              className="profile-banner"
              style={
                profile.bannerUrl
                  ? { backgroundImage: `url("${profile.bannerUrl}")` }
                  : profileStyle(null, bannerNumber ?? profile.bannerColor)
              }
              data-color={profile.bannerUrl ? undefined : ''}
            />
            <div className="profile-head">
              <Avatar user={{ ...me, avatarUrl: profile.avatarUrl }} size={72} status="online" />
            </div>
            <div className="profile-body">
              <div className="profile-name">{me.displayName}</div>
              <div className="profile-sub">{pronouns}</div>
              {(profile.statusEmoji || profile.statusText) && (
                <div className="profile-custom-status">
                  {profile.statusEmoji && <EmojiValue value={profile.statusEmoji} />}
                  <span>{profile.statusText}</span>
                </div>
              )}
              {bio && (
                <section className="profile-section">
                  <h3>About me</h3>
                  <div className="profile-bio">
                    <Markdown content={bio} nameOf={() => undefined} meId={me.id} />
                  </div>
                </section>
              )}
            </div>
          </div>
        </aside>
      </div>
      <AvatarCropDialog
        file={cropping}
        onCancel={() => setCropping(null)}
        onCropped={(blob) => {
          setCropping(null);
          void uploadAvatar(blob, 'avatar.png');
        }}
      />
    </SettingsPage>
  );
}
