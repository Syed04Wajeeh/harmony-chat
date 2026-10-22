import { MAX_CUSTOM_CSS_BYTES, cssByteLength, sanitizeCss } from '@harmony/shared';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { useSettings } from '../../store/settings.js';
import { SwitchRow } from './controls.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

const HOOKS = [
  'message',
  'message-author',
  'message-content',
  'message-list',
  'sidebar',
  'channel-link',
  'channel-header',
  'composer',
  'member-list',
  'guild-rail',
  'guild-banner',
  'user-panel',
  'embed',
  'avatar',
];

const INDENT = '  ';

export function AdvancedAppearancePage() {
  const appearance = useSettings((state) => state.settings.appearance);
  const safeMode = useSettings((state) => state.safeMode);
  const update = useSettings((state) => state.update);
  const [draft, setDraft] = useState(appearance.customCss);

  const bytes = cssByteLength(draft);
  const tooLarge = bytes > MAX_CUSTOM_CSS_BYTES;
  const removed = useMemo(() => sanitizeCss(draft).removed, [draft]);
  const dirty = draft !== appearance.customCss;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Tab' || event.shiftKey) return;
    event.preventDefault();
    const field = event.currentTarget;
    const { selectionStart: from, selectionEnd: to } = field;
    setDraft(draft.slice(0, from) + INDENT + draft.slice(to));
    requestAnimationFrame(() =>
      field.setSelectionRange(from + INDENT.length, from + INDENT.length),
    );
  }

  return (
    <SettingsPage title="Advanced" back="/settings/user">
      <p className="settings-lead">
        Custom CSS restyles Harmony for you only. It is off until you turn it on, and you can always
        recover by opening Harmony with <code>?safe</code> at the end of the address.
      </p>
      {safeMode && (
        <p className="settings-lead" role="status">
          Safe mode is on: your CSS is not applied on this page load.
        </p>
      )}
      <SettingsCard title="Custom CSS">
        <SwitchRow
          label="Apply my custom CSS"
          checked={appearance.customCssEnabled}
          onChange={(customCssEnabled) => update({ appearance: { customCssEnabled } })}
        />
        <label className="field">
          <span>Stylesheet</span>
          <textarea
            className="code-input"
            rows={14}
            value={draft}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-describedby="css-help"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              '[data-harmony="message"]:hover {\n  background: var(--color-bg-hover);\n}'
            }
          />
        </label>
        <p id="css-help" className="field-hint" data-over={tooLarge || undefined}>
          {(bytes / 1024).toFixed(1)} KB of {MAX_CUSTOM_CSS_BYTES / 1024} KB
          {removed.length > 0 &&
            `. These are removed when saved: ${removed.join(', ')} (remote loads are blocked).`}
        </p>
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            disabled={!dirty}
            onClick={() => setDraft(appearance.customCss)}
          >
            Revert
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={!dirty || tooLarge}
            onClick={() => {
              const { css } = sanitizeCss(draft);
              setDraft(css);
              update({ appearance: { customCss: css } });
            }}
          >
            Save CSS
          </button>
        </div>
      </SettingsCard>
      <SettingsCard
        title="Hooks"
        description={
          <>
            Stable selectors that survive updates: <code>{'[data-harmony="…"]'}</code>. Theme colors
            are CSS variables such as <code>var(--color-accent)</code>.
          </>
        }
      >
        <ul className="hook-list">
          {HOOKS.map((hook) => (
            <li key={hook}>
              <code>{hook}</code>
            </li>
          ))}
        </ul>
      </SettingsCard>
    </SettingsPage>
  );
}
