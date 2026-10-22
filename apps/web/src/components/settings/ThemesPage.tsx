import {
  MAX_CUSTOM_THEMES,
  PRESET_THEMES,
  THEME_MODES,
  importTheme,
  type CustomTheme,
  type PresetTheme,
} from '@harmony/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client.js';
import { useMediaQuery } from '../../hooks/useMediaQuery.js';
import { resolveTheme } from '../../lib/appearance.js';
import { attempt } from '../../store/actions.js';
import { useSettings } from '../../store/settings.js';
import { Modal } from '../Overlay.js';
import { Segmented } from './controls.js';
import { ThemeMiniPreview } from './appearance/ThemePreview.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

const MODE_LABELS = { system: 'System', dark: 'Dark', light: 'Light' } as const;

function ThemeCard({
  theme,
  selected,
  onApply,
  onCustomize,
  customizeLabel = 'Customize',
}: {
  theme: PresetTheme | CustomTheme;
  selected: boolean;
  onApply: () => void;
  onCustomize: () => void;
  customizeLabel?: string;
}) {
  return (
    <li className="theme-card" data-selected={selected || undefined} data-theme-id={theme.id}>
      <ThemeMiniPreview theme={theme} />
      <div className="theme-card-body">
        <div className="theme-card-title">
          <strong>{theme.name}</strong>
          <small>{theme.base === 'dark' ? 'Dark' : 'Light'}</small>
        </div>
        <div className="theme-card-actions">
          <button
            type="button"
            className={selected ? 'button' : 'button button-primary'}
            aria-pressed={selected}
            aria-label={`${selected ? 'Using' : 'Use'} ${theme.name}`}
            onClick={onApply}
          >
            {selected ? 'In use' : 'Use'}
          </button>
          <button
            type="button"
            className="button button-ghost"
            aria-label={`${customizeLabel} ${theme.name}`}
            onClick={onCustomize}
          >
            {customizeLabel}
          </button>
        </div>
      </div>
    </li>
  );
}

export function ThemesPage() {
  const navigate = useNavigate();
  const appearance = useSettings((state) => state.settings.appearance);
  const themes = useSettings((state) => state.themes);
  const safeMode = useSettings((state) => state.safeMode);
  const update = useSettings((state) => state.update);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const active = resolveTheme(appearance, { customThemes: themes, prefersDark, safeMode });
  const harmonyInUse = active.theme.builtin === true;

  function apply(theme: PresetTheme | CustomTheme) {
    // Choosing a Harmony theme by hand also pins the mode; the others bring their own.
    update({
      appearance: {
        themeId: theme.id,
        ...('builtin' in theme && theme.builtin && { mode: theme.base }),
      },
    });
  }

  async function runImport() {
    const result = importTheme(text);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const created = await attempt(api.createTheme(result.theme), 'Could not import the theme');
    if (!created) return;
    setImporting(false);
    setText('');
    setError(null);
    void navigate(`/settings/user/themes/${created.id}`);
  }

  return (
    <SettingsPage title="Themes" back="/settings/user">
      {safeMode && (
        <p className="settings-lead" role="status">
          Safe mode is on, so Harmony is showing its own theme. Reload without <code>?safe</code> to
          use yours.
        </p>
      )}
      <SettingsCard
        title="Color mode"
        description="Applies to the Harmony themes. Every other theme is either dark or light on its own."
      >
        <Segmented
          legend="Color mode"
          name="mode"
          options={THEME_MODES}
          labels={MODE_LABELS}
          value={appearance.mode}
          disabled={!harmonyInUse}
          onChange={(mode) => update({ appearance: { mode } })}
        />
      </SettingsCard>
      <SettingsCard
        title="Presets"
        description="Each one passes WCAG AA; High Contrast aims for AAA."
      >
        <ul className="theme-grid">
          {PRESET_THEMES.map((preset) => (
            <ThemeCard
              key={preset.id}
              theme={preset}
              selected={active.theme.id === preset.id}
              onApply={() => apply(preset)}
              onCustomize={() => void navigate(`/settings/user/themes/new?from=${preset.id}`)}
            />
          ))}
        </ul>
      </SettingsCard>
      <SettingsCard
        title="My themes"
        description={`${String(themes.length)} of ${String(MAX_CUSTOM_THEMES)} used. Only you see these.`}
      >
        {themes.length > 0 && (
          <ul className="theme-grid">
            {themes.map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                selected={active.theme.id === theme.id}
                onApply={() => apply(theme)}
                onCustomize={() => void navigate(`/settings/user/themes/${theme.id}`)}
                customizeLabel="Edit"
              />
            ))}
          </ul>
        )}
        <div className="settings-toolbar">
          <button
            type="button"
            className="button"
            disabled={themes.length >= MAX_CUSTOM_THEMES}
            onClick={() => void navigate('/settings/user/themes/new?from=harmony-dark')}
          >
            New theme
          </button>
          <button
            type="button"
            className="button"
            disabled={themes.length >= MAX_CUSTOM_THEMES}
            onClick={() => setImporting(true)}
          >
            Import from text
          </button>
        </div>
      </SettingsCard>
      <Modal
        open={importing}
        onOpenChange={(open) => {
          setImporting(open);
          if (!open) setError(null);
        }}
        title="Import a theme"
        description="Paste a theme string someone shared. It is checked the same way as a theme you build here."
      >
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void runImport();
          }}
        >
          <label className="field">
            <span>Theme string</span>
            <textarea
              className="code-input"
              rows={6}
              value={text}
              spellCheck={false}
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
              }}
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setImporting(false)}>
              Cancel
            </button>
            <button className="button button-primary" disabled={!text.trim()}>
              Import
            </button>
          </div>
        </form>
      </Modal>
    </SettingsPage>
  );
}
