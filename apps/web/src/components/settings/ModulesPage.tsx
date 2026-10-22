import type { GuildModule } from '@harmony/shared';
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { api } from '../../api/client.js';
import { fieldsFromSchema } from '../../lib/schemaFields.js';
import { webModules } from '../../modules/index.js';
import { attempt, loadGuildModules } from '../../store/actions.js';
import { appStore, useApp } from '../../store/store.js';
import { SchemaForm } from './SchemaForm.js';
import { SettingsPage } from './SettingsLayout.js';

function ModuleCard({ guildId, module }: { guildId: string; module: GuildModule }) {
  const fields = fieldsFromSchema(module.settingsSchema);
  const Panel = webModules.find((web) => web.id === module.id)?.guildSettingsPanel;

  async function update(body: Parameters<typeof api.updateGuildModule>[2]) {
    const updated = await attempt(
      api.updateGuildModule(guildId, module.id, body),
      `Could not update ${module.name}`,
    );
    if (!updated) return;
    const current = appStore.getState().guildModules[guildId] ?? [];
    appStore.getState().setGuildModules(
      guildId,
      current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
    );
  }

  return (
    <section className="settings-card module-card" data-enabled={module.enabled || undefined}>
      <label className="switch-row">
        <span>
          <strong>{module.name}</strong>
          <small>{module.description}</small>
          {!module.optional && <small className="module-tag">Always on</small>}
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label={`${module.name} enabled`}
          checked={module.enabled}
          disabled={!module.optional}
          onChange={(event) => void update({ enabled: event.target.checked })}
        />
      </label>
      {module.enabled && fields.length > 0 && (
        <SchemaForm
          fields={fields}
          values={module.settings}
          onChange={(settings) => void update({ settings })}
        />
      )}
      {module.enabled && Panel && <Panel guildId={guildId} />}
    </section>
  );
}

export function ModulesPage() {
  const { guildId = '' } = useParams();
  const modules = useApp((state) => state.guildModules[guildId]);

  useEffect(() => {
    void loadGuildModules(guildId);
  }, [guildId]);

  return (
    <SettingsPage title="Modules" back={`/settings/server/${guildId}`}>
      <p className="settings-lead">
        Turn features on or off for this server. Anything switched off disappears for everyone in
        it, and anything already posted stays where it is.
      </p>
      {modules === undefined ? (
        <p className="empty-note">Loading…</p>
      ) : (
        modules.map((module) => <ModuleCard key={module.id} guildId={guildId} module={module} />)
      )}
    </SettingsPage>
  );
}
