import type { Behavior } from '@harmony/shared';
import { useSettings } from '../../store/settings.js';
import { Segmented, SwitchRow } from './controls.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

const IDLE_OPTIONS = [0, 5, 10, 30, 60] as const;

export function BehaviorPage() {
  const behavior = useSettings((state) => state.settings.behavior);
  const update = useSettings((state) => state.update);
  const set = (patch: Partial<Behavior>) => update({ behavior: patch });

  return (
    <SettingsPage title="Behavior" back="/settings/user">
      <p className="settings-lead">How Harmony acts, saved to your account.</p>
      <SettingsCard title="Messages">
        <SwitchRow
          label="Show avatars"
          description="Profile pictures next to messages."
          checked={behavior.showAvatars}
          onChange={(showAvatars) => set({ showAvatars })}
        />
        <SwitchRow
          label="Group consecutive messages"
          description="Hide repeated names when the same person posts several times in a row."
          checked={behavior.messageGrouping}
          onChange={(messageGrouping) => set({ messageGrouping })}
        />
        <SwitchRow
          label="Link previews"
          description="Reserved. Harmony does not generate previews yet."
          checked={behavior.linkPreviews}
          onChange={(linkPreviews) => set({ linkPreviews })}
        />
        <div className="field">
          <span>Time format</span>
          <Segmented
            legend="Time format"
            name="time-format"
            options={['12h', '24h'] as const}
            labels={{ '12h': '12-hour', '24h': '24-hour' }}
            value={behavior.timeFormat}
            onChange={(timeFormat) => set({ timeFormat })}
          />
        </div>
      </SettingsCard>
      <SettingsCard title="Composer">
        <SwitchRow
          label="Enter sends the message"
          description="Off: Ctrl or Cmd+Enter sends and Enter adds a line. Phones always have a send button."
          checked={behavior.sendOnEnter}
          onChange={(sendOnEnter) => set({ sendOnEnter })}
        />
      </SettingsCard>
      <SettingsCard title="Layout">
        <div className="field">
          <span>Member list</span>
          <Segmented
            legend="Member list"
            name="members-default"
            options={['open', 'closed'] as const}
            labels={{ open: 'Open', closed: 'Closed' }}
            value={behavior.memberListDefault}
            onChange={(memberListDefault) => set({ memberListDefault })}
          />
        </div>
      </SettingsCard>
      <SettingsCard
        title="Presence"
        description="Go idle after this long without activity. Others then see you as away."
      >
        <label className="field">
          <span>Mark me idle after</span>
          <select
            value={behavior.autoIdleMinutes}
            onChange={(event) => set({ autoIdleMinutes: Number(event.target.value) })}
          >
            {IDLE_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes === 0 ? 'Never' : `${String(minutes)} minutes`}
              </option>
            ))}
          </select>
        </label>
      </SettingsCard>
    </SettingsPage>
  );
}
