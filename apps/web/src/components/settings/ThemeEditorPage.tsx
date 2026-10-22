import {
  MAX_THEME_NAME_LENGTH,
  PRESET_THEMES,
  ThemeInput,
  exportTheme,
  findPreset,
  isValidTokenValue,
  type CustomTheme,
  type ThemeBase,
  type ThemeTokens,
} from '@harmony/shared';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../../api/client.js';
import { completeTokens } from '../../lib/appearance.js';
import {
  ACCENT_SWATCHES,
  RADIUS_FIELDS,
  TOKEN_GROUPS,
  autoFixContrast,
  checkContrast,
  keepAlpha,
  toInputHex,
  withAccent,
  type TokenField,
} from '../../lib/themeEditor.js';
import { attempt } from '../../store/actions.js';
import { useSettings } from '../../store/settings.js';
import { useUi } from '../../store/ui.js';
import { ConfirmDialog } from '../Overlay.js';
import { RangeField, Segmented } from './controls.js';
import { ChatPreview } from './appearance/ThemePreview.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

interface Draft {
  name: string;
  base: ThemeBase;
  tokens: ThemeTokens;
}

function ColorField({
  field,
  value,
  onChange,
}: {
  field: TokenField;
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const invalid = text !== null && !isValidTokenValue(field.token, text.trim());
  return (
    <div className="color-field" data-invalid={invalid || undefined}>
      <input
        type="color"
        aria-label={`${field.label} color picker`}
        value={toInputHex(value)}
        onChange={(event) => {
          setText(null);
          onChange(keepAlpha(value, event.target.value));
        }}
      />
      <span className="color-field-label">
        <span>{field.label}</span>
        {field.hint && <small>{field.hint}</small>}
      </span>
      <input
        type="text"
        className="color-text"
        aria-label={`${field.label} value`}
        aria-invalid={invalid}
        spellCheck={false}
        value={text ?? value ?? ''}
        onChange={(event) => {
          setText(event.target.value);
          if (isValidTokenValue(field.token, event.target.value.trim())) {
            onChange(event.target.value.trim());
          }
        }}
        onBlur={() => setText(null)}
      />
    </div>
  );
}

function ContrastPanel({ tokens, onFix }: { tokens: ThemeTokens; onFix: () => void }) {
  const results = checkContrast(tokens);
  const failing = results.filter((result) => result.level === 'fail');
  return (
    <SettingsCard
      title="Contrast"
      description="WCAG 2.2 ratios for the pairs the interface relies on. AA needs 4.5:1 for text, AAA needs 7:1."
    >
      <ul className="contrast-list">
        {results.map(({ check, ratio, level }) => (
          <li key={check.id} data-level={level} data-contrast={check.id}>
            <span
              className="contrast-sample"
              aria-hidden="true"
              style={{ background: tokens['color-bg-panel'] }}
            >
              <i
                style={{
                  color: tokens[check.foreground],
                  background: tokens[check.backgrounds[0] ?? 'color-bg-panel'],
                }}
              >
                Aa
              </i>
            </span>
            <span className="contrast-label">{check.label}</span>
            <span className="contrast-ratio">{ratio.toFixed(1)}:1</span>
            <span className="contrast-badge" data-level={level}>
              {level === 'fail' ? 'Fail' : level}
            </span>
          </li>
        ))}
      </ul>
      <div className="contrast-summary" role="status">
        {failing.length === 0 ? (
          <p>Every pair reaches AA.</p>
        ) : (
          <p className="contrast-warning">
            {failing.length === 1 ? '1 pair is' : `${String(failing.length)} pairs are`} below AA
            and may be hard to read: {failing.map((r) => r.check.label.toLowerCase()).join(', ')}.
          </p>
        )}
        <button type="button" className="button" disabled={failing.length === 0} onClick={onFix}>
          Auto-fix
        </button>
      </div>
    </SettingsCard>
  );
}

export function ThemeEditorPage() {
  const { ref = 'new' } = useParams();
  const [params] = useSearchParams();
  const themes = useSettings((state) => state.themes);
  const existing = ref === 'new' ? undefined : themes.find((theme) => theme.id === ref);
  if (ref !== 'new' && !existing) {
    return (
      <SettingsPage title="Theme not found" back="/settings/user/themes">
        <p className="settings-lead">
          That theme does not exist any more. <Link to="/settings/user/themes">Back to themes</Link>
        </p>
      </SettingsPage>
    );
  }
  const preset = findPreset(params.get('from') ?? '') ?? PRESET_THEMES[0];
  const source = existing ?? preset;
  // Remount for a different theme so the draft starts from it.
  return (
    <Editor key={existing?.id ?? `new-${source?.id ?? ''}`} existing={existing} source={source} />
  );
}

function Editor({
  existing,
  source,
}: {
  existing: CustomTheme | undefined;
  source: { name: string; base: ThemeBase; tokens: ThemeTokens } | undefined;
}) {
  const navigate = useNavigate();
  const update = useSettings((state) => state.update);
  const setThemes = useSettings((state) => state.setThemes);
  const start: Draft = {
    name: existing ? existing.name : `${source?.name ?? 'My'} copy`.slice(0, MAX_THEME_NAME_LENGTH),
    base: source?.base ?? 'dark',
    tokens: source ? completeTokens(source) : {},
  };
  const [draft, setDraft] = useState<Draft>(start);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const share = useRef<HTMLTextAreaElement>(null);

  const setToken = (token: keyof ThemeTokens, value: string) =>
    setDraft((current) => ({ ...current, tokens: { ...current.tokens, [token]: value } }));
  const input = ThemeInput.safeParse({ name: draft.name, base: draft.base, tokens: draft.tokens });
  const dirty = JSON.stringify(draft) !== JSON.stringify(start);

  async function save(mode: 'update' | 'new', use: boolean) {
    if (!input.success) return;
    setBusy(true);
    const saved = await attempt(
      existing && mode === 'update'
        ? api.updateTheme(existing.id, input.data)
        : api.createTheme(input.data),
      'Could not save the theme',
    );
    setBusy(false);
    if (!saved) return;
    const others = useSettings.getState().themes.filter((theme) => theme.id !== saved.id);
    setThemes([...others, saved].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    if (use) update({ appearance: { themeId: saved.id } });
    useUi.getState().pushToast('Theme saved', 'info');
    if (!existing || mode === 'new')
      void navigate(`/settings/user/themes/${saved.id}`, { replace: true });
  }

  async function remove() {
    if (!existing) return;
    const deleted = await attempt(
      api.deleteTheme(existing.id).then(() => true),
      'Could not delete',
    );
    if (!deleted) return;
    setThemes(useSettings.getState().themes.filter((theme) => theme.id !== existing.id));
    void navigate('/settings/user/themes', { replace: true });
  }

  async function copy() {
    const text = exportTheme(draft);
    try {
      await navigator.clipboard.writeText(text);
      useUi.getState().pushToast('Theme string copied', 'info');
    } catch {
      share.current?.select();
    }
  }

  const radius = (token: 'radius-panel' | 'radius-card' | 'radius-control') =>
    Number.parseFloat(draft.tokens[token] ?? '0');

  return (
    <SettingsPage title={existing ? 'Edit theme' : 'New theme'} back="/settings/user/themes">
      <div className="theme-editor">
        <details className="editor-preview" open>
          <summary>Preview</summary>
          <ChatPreview theme={draft} />
        </details>

        <div className="editor-controls">
          <SettingsCard title="Theme">
            <label className="field">
              <span>Name</span>
              <input
                value={draft.name}
                maxLength={MAX_THEME_NAME_LENGTH}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <div className="field">
              <span>Base</span>
              <Segmented
                legend="Base"
                name="theme-base"
                options={['dark', 'light'] as const}
                labels={{ dark: 'Dark', light: 'Light' }}
                value={draft.base}
                onChange={(base) => setDraft({ ...draft, base })}
              />
              <small className="field-hint">
                Sets browser chrome and form controls. Colors below do the real work.
              </small>
            </div>
          </SettingsCard>

          <SettingsCard
            title="Accent"
            description="Pick one color and the related shades are worked out for you."
          >
            <div className="swatches" role="group" aria-label="Accent quick picker">
              {ACCENT_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className="swatch"
                  style={{ background: hex }}
                  aria-label={`Accent ${hex}`}
                  aria-pressed={draft.tokens['color-accent']?.toLowerCase() === hex}
                  onClick={() =>
                    setDraft({ ...draft, tokens: withAccent(draft.tokens, draft.base, hex) })
                  }
                />
              ))}
              <label className="swatch swatch-custom">
                <input
                  type="color"
                  aria-label="Custom accent"
                  value={toInputHex(draft.tokens['color-accent'])}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      tokens: withAccent(draft.tokens, draft.base, event.target.value),
                    })
                  }
                />
              </label>
            </div>
          </SettingsCard>

          <ContrastPanel
            tokens={draft.tokens}
            onFix={() => setDraft({ ...draft, tokens: autoFixContrast(draft.tokens) })}
          />

          {TOKEN_GROUPS.map((group) => (
            <SettingsCard key={group.id} title={group.title}>
              <div className="color-grid">
                {group.fields.map((field) => (
                  <ColorField
                    key={field.token}
                    field={field}
                    value={draft.tokens[field.token]}
                    onChange={(value) => setToken(field.token, value)}
                  />
                ))}
              </div>
            </SettingsCard>
          ))}

          <SettingsCard title="Shape" description="Corner roundness across the interface.">
            {RADIUS_FIELDS.map(({ token, label, max }) => (
              <RangeField
                key={token}
                label={label}
                min={0}
                max={max}
                step={1}
                value={radius(token)}
                format={(value) => `${String(value)}px`}
                onChange={(value) => setToken(token, `${String(value)}px`)}
              />
            ))}
            <RangeField
              label="Avatars"
              min={0}
              max={50}
              step={1}
              value={Number.parseFloat(draft.tokens['avatar-shape'] ?? '30')}
              format={(value) =>
                value >= 50 ? 'Circle' : value === 0 ? 'Square' : `${String(value)}%`
              }
              onChange={(value) => setToken('avatar-shape', `${String(value)}%`)}
            />
          </SettingsCard>

          <SettingsCard
            title="Share"
            description="Copy this string to give the theme to someone else. They import it from the themes page."
          >
            <textarea
              ref={share}
              className="code-input"
              readOnly
              rows={4}
              aria-label="Theme string"
              value={exportTheme(draft)}
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="modal-actions">
              <button type="button" className="button" onClick={() => void copy()}>
                Copy theme string
              </button>
            </div>
          </SettingsCard>

          <div className="save-bar">
            {existing && (
              <button
                type="button"
                className="button button-danger-outline"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
            <button
              type="button"
              className="button button-ghost"
              disabled={!dirty}
              onClick={() => setDraft(start)}
            >
              {existing ? 'Revert changes' : 'Reset to preset'}
            </button>
            {existing && (
              <button
                type="button"
                className="button"
                disabled={busy || !input.success}
                onClick={() => void save('new', false)}
              >
                Save as new
              </button>
            )}
            <button
              type="button"
              className="button"
              disabled={busy || !input.success || (!!existing && !dirty)}
              onClick={() => void save('update', false)}
            >
              {existing ? 'Save' : 'Save theme'}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || !input.success}
              onClick={() => void save('update', true)}
            >
              Save and use
            </button>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${existing?.name ?? 'theme'}?`}
        description="If you are using it, Harmony goes back to its default theme."
        confirmLabel="Delete theme"
        danger
        onConfirm={() => void remove()}
      />
    </SettingsPage>
  );
}
