import {
  DENSITIES,
  MAX_FONT_SCALE,
  MESSAGE_FONTS,
  MIN_FONT_SCALE,
  PANEL_STYLES,
  REDUCED_MOTION,
  type Appearance,
} from '@harmony/shared';
import { MESSAGE_FONT_STACKS } from '../../lib/appearance.js';
import { useSettings } from '../../store/settings.js';
import { Avatar } from '../Avatar.js';
import { RangeField, Segmented, SwitchRow } from './controls.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

const DENSITY_LABELS = { compact: 'Compact', cozy: 'Cozy', comfortable: 'Comfortable' } as const;
const PANEL_LABELS = { floating: 'Floating', flat: 'Flat' } as const;
const MOTION_LABELS = { system: 'Match device', on: 'Reduce', off: 'Full' } as const;

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
  const appearance = useSettings((state) => state.settings.appearance);
  const update = useSettings((state) => state.update);
  const set = (patch: Partial<Appearance>) => update({ appearance: patch });

  return (
    <SettingsPage title="Appearance" back="/settings/user">
      <p className="settings-lead">
        Saved to your account, so every device you sign in on looks the same. Colors live under
        Themes.
      </p>
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
          onChange={(density) => set({ density })}
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
          onChange={(panels) => set({ panels })}
        />
      </SettingsCard>
      <SettingsCard title="Text" description="Scales everything that is sized in text units.">
        <RangeField
          label="Text size"
          value={appearance.fontScale}
          min={MIN_FONT_SCALE}
          max={MAX_FONT_SCALE}
          step={0.0625}
          format={(value) => `${String(Math.round(value * 100))}%`}
          onChange={(fontScale) => set({ fontScale })}
        />
        <label className="field">
          <span>Message font</span>
          <select
            value={appearance.messageFont}
            onChange={(event) =>
              set({ messageFont: event.target.value as Appearance['messageFont'] })
            }
          >
            {MESSAGE_FONTS.map((font) => (
              <option key={font} value={font}>
                {MESSAGE_FONT_STACKS[font].label}
              </option>
            ))}
          </select>
          <small className="field-hint">
            Atkinson Hyperlegible is designed for low vision. All fonts ship with the app.
          </small>
        </label>
      </SettingsCard>
      <SettingsCard title="Motion" description="Animations and transitions across the app.">
        <Segmented
          legend="Motion"
          name="motion"
          options={REDUCED_MOTION}
          labels={MOTION_LABELS}
          value={appearance.reducedMotion}
          onChange={(reducedMotion) => set({ reducedMotion })}
        />
      </SettingsCard>
      <SettingsCard title="Servers">
        <SwitchRow
          label="Use each server's accent color"
          description="Recolors buttons and highlights while a server with an accent is open. Your own custom themes always win."
          checked={appearance.useGuildAccent}
          onChange={(useGuildAccent) => set({ useGuildAccent })}
        />
      </SettingsCard>
      <SettingsCard title="Preview">
        <Preview />
      </SettingsCard>
    </SettingsPage>
  );
}
