import { useState } from 'react';
import {
  DENSITIES,
  PANEL_STYLES,
  THEMES,
  loadAppearance,
  saveAppearance,
  type Appearance,
} from '../../lib/appearance.js';
import { Avatar } from '../Avatar.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

const THEME_LABELS = { system: 'System', dark: 'Dark', light: 'Light' } as const;
const DENSITY_LABELS = { compact: 'Compact', cozy: 'Cozy', comfortable: 'Comfortable' } as const;
const PANEL_LABELS = { floating: 'Floating', flat: 'Flat' } as const;

function Segmented<T extends string>({
  legend,
  name,
  options,
  labels,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={legend} className="segmented">
      {options.map((option) => (
        <label key={option}>
          <input
            type="radio"
            name={name}
            value={option}
            checked={value === option}
            onChange={() => onChange(option)}
          />
          {labels[option]}
        </label>
      ))}
    </div>
  );
}

const PREVIEW_ADA = { id: 'preview-ada', displayName: 'Ada', avatarUrl: null };
const PREVIEW_LINUS = { id: 'preview-linus', displayName: 'Linus', avatarUrl: null };

/** Real message markup, so the preview follows every token, attribute and density change. */
function Preview() {
  return (
    <ul className="appearance-preview" aria-label="Preview">
      <li className="message">
        <div className="message-row">
          <div className="message-gutter">
            <Avatar user={PREVIEW_LINUS} size={40} />
          </div>
          <div className="message-body">
            <div className="message-header">
              <span className="message-author">Linus</span>
              <time>Today at 6:42 PM</time>
            </div>
            <div className="message-content">
              <p>Friday works for me. I will bring the good tea.</p>
            </div>
          </div>
        </div>
      </li>
      <li className="message" data-mentioned>
        <div className="message-row">
          <div className="message-gutter">
            <Avatar user={PREVIEW_ADA} size={40} />
          </div>
          <div className="message-body">
            <div className="message-header">
              <span className="message-author">Ada</span>
              <time>Today at 6:44 PM</time>
            </div>
            <div className="message-content">
              <p>
                <span className="mention mention-me">@Ada</span> can you check the{' '}
                <code className="md-code">reading-list</code> file?
              </p>
            </div>
          </div>
        </div>
      </li>
    </ul>
  );
}

export function AppearancePage() {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const update = (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    setAppearance(next);
    saveAppearance(next);
  };

  return (
    <SettingsPage title="Appearance" back="/settings/user">
      <p className="settings-lead">
        These choices apply to this browser and take effect immediately.
      </p>
      <SettingsCard title="Theme" description="System follows your device's light or dark setting.">
        <Segmented
          legend="Theme"
          name="theme"
          options={THEMES}
          labels={THEME_LABELS}
          value={appearance.theme}
          onChange={(theme) => update({ theme })}
        />
      </SettingsCard>
      <SettingsCard
        title="Density"
        description="How much room messages and lists take. Touch screens keep larger tap targets."
      >
        <Segmented
          legend="Density"
          name="density"
          options={DENSITIES}
          labels={DENSITY_LABELS}
          value={appearance.density}
          onChange={(density) => update({ density })}
        />
      </SettingsCard>
      <SettingsCard
        title="Panels"
        description="Floating shows rounded cards on a canvas. Flat runs edge to edge."
      >
        <Segmented
          legend="Panels"
          name="panels"
          options={PANEL_STYLES}
          labels={PANEL_LABELS}
          value={appearance.panels}
          onChange={(panels) => update({ panels })}
        />
      </SettingsCard>
      <SettingsCard title="Preview">
        <Preview />
      </SettingsCard>
    </SettingsPage>
  );
}
