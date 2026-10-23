import { EMOJI_NAME, type GuildEmoji } from '@harmony/shared';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { api, uploadFile } from '../../api/client.js';
import { attempt } from '../../store/actions.js';
import { useProfiles } from '../../store/profiles.js';
import { CustomEmoji } from '../Emoji.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

const slug = (filename: string) =>
  filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .padEnd(2, '_');

function EmojiRow({ guildId, emoji }: { guildId: string; emoji: GuildEmoji }) {
  const [name, setName] = useState(emoji.name);
  const valid = EMOJI_NAME.test(name);
  return (
    <li className="emoji-row">
      <CustomEmoji id={emoji.id} name={emoji.name} />
      <div className="emoji-row-name">
        <span aria-hidden="true">:</span>
        <input
          aria-label={`Name of ${emoji.name}`}
          value={name}
          aria-invalid={!valid}
          onChange={(event) => setName(event.target.value.toLowerCase())}
          onBlur={() => {
            if (valid && name !== emoji.name) {
              void attempt(api.renameEmoji(guildId, emoji.id, name), 'Could not rename the emoji');
            } else setName(emoji.name);
          }}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
        <span aria-hidden="true">:</span>
      </div>
      <span className="emoji-row-meta">
        {emoji.animated ? 'Animated · ' : ''}Added by {emoji.createdByName ?? 'someone who left'}
      </span>
      <button
        className="button button-danger"
        onClick={() =>
          void attempt(api.deleteEmoji(guildId, emoji.id), 'Could not delete the emoji')
        }
      >
        Delete
      </button>
    </li>
  );
}

export function EmojiPage() {
  const { guildId = '' } = useParams();
  const all = useProfiles((state) => state.emoji);
  const emoji = all.filter((item) => item.guildId === guildId);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.guildEmoji(guildId).then((list) => useProfiles.getState().emojiUpdated(guildId, list));
  }, [guildId]);

  async function upload(files: File[]) {
    setBusy(true);
    for (const file of files) {
      const attachment = await attempt(uploadFile(file), `Could not upload ${file.name}`);
      if (attachment) {
        await attempt(
          api.createEmoji(guildId, slug(file.name), attachment.id),
          `Could not add ${file.name}`,
        );
      }
    }
    setBusy(false);
  }

  return (
    <SettingsPage title="Emoji" back={`/settings/server/${guildId}`}>
      <p className="settings-lead">
        Custom emoji for this server. Type <code>:</code> and two letters in the composer to use
        one; members with the cross-server perk can use them in other servers too.
      </p>
      <SettingsCard
        title="Upload"
        description="PNG, GIF or WebP, up to 256 KB and 128×128 pixels. The file name becomes the emoji name."
      >
        <button
          className="button button-primary"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? 'Uploading…' : 'Upload emoji'}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept="image/png,image/gif,image/webp"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            void upload(files);
          }}
        />
      </SettingsCard>
      <SettingsCard title={`Emoji — ${String(emoji.length)}`}>
        {emoji.length === 0 ? (
          <p className="empty-note">No custom emoji yet.</p>
        ) : (
          <ul className="emoji-list">
            {emoji.map((item) => (
              <EmojiRow key={`${item.id}:${item.name}`} guildId={guildId} emoji={item} />
            ))}
          </ul>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}
