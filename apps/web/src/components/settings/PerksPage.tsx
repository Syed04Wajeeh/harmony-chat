import { PERK_LABELS, type Perk, type PerksOverview } from '@harmony/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { attempt } from '../../store/actions.js';
import { useProfiles } from '../../store/profiles.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

export function PerksPage() {
  const [overview, setOverview] = useState<PerksOverview | null>(null);
  const reload = () => api.perksOverview().then(setOverview);
  useEffect(() => void reload(), []);

  async function toggle(userId: string, perk: Perk, granted: boolean) {
    await attempt(
      granted ? api.revokePerk(userId, perk) : api.grantPerk(userId, perk),
      'Could not change the perk',
    );
    await reload();
    void useProfiles.getState().refresh();
  }

  return (
    <SettingsPage title="Perks" back="/settings/user">
      <p className="settings-lead">
        Perks are free extras that instance admins hand out. Everyone gets the default set; grants
        below add to it for one person.
      </p>
      {overview && (
        <>
          <SettingsCard
            title="Default perks"
            description={
              <>
                Set by the <code>PERKS_DEFAULT</code> environment variable (read-only here).
              </>
            }
          >
            {overview.defaults.length === 0 ? (
              <p className="empty-note">None. Only explicit grants apply.</p>
            ) : (
              <ul className="perk-chips">
                {overview.defaults.map((perk) => (
                  <li key={perk} className="role-chip">
                    {PERK_LABELS[perk].name}
                  </li>
                ))}
              </ul>
            )}
          </SettingsCard>
          <SettingsCard title="People">
            <div className="perk-table" role="table" aria-label="Perks by person">
              <div className="perk-row perk-head" role="row">
                <span role="columnheader">Person</span>
                {overview.all.map((perk) => (
                  <span key={perk} role="columnheader" title={PERK_LABELS[perk].description}>
                    {PERK_LABELS[perk].name}
                  </span>
                ))}
              </div>
              {overview.users.map((user) => (
                <div key={user.id} className="perk-row" role="row">
                  <span role="cell" className="perk-person">
                    {user.displayName}
                    <small>{user.login}</small>
                  </span>
                  {overview.all.map((perk) => {
                    const grant = user.grants.find((item) => item.perk === perk);
                    const inherited = overview.defaults.includes(perk);
                    return (
                      <span key={perk} role="cell">
                        <input
                          type="checkbox"
                          aria-label={`${PERK_LABELS[perk].name} for ${user.displayName}`}
                          checked={inherited || grant !== undefined}
                          disabled={inherited}
                          title={
                            grant
                              ? `Granted by ${grant.grantedByName ?? 'an admin'} on ${new Date(grant.grantedAt).toLocaleDateString()}`
                              : inherited
                                ? 'Included in the default perks'
                                : undefined
                          }
                          onChange={() => void toggle(user.id, perk, grant !== undefined)}
                        />
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </SettingsCard>
        </>
      )}
    </SettingsPage>
  );
}
