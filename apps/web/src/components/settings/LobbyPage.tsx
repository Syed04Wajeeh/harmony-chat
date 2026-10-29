import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { attempt } from '../../store/actions.js';
import { useApp } from '../../store/store.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

/** Instance admins pick the one server every new user joins on first sign-in, or none. */
export function LobbyPage() {
  const guilds = useApp((state) => state.guilds);
  const [lobby, setLobby] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    void attempt(api.lobby(), 'Could not load the lobby setting').then((response) => {
      if (response) setLobby(response.guildId);
    });
  }, []);

  async function choose(value: string) {
    const guildId = value === '' ? null : value;
    const saved = await attempt(api.setLobby(guildId), 'Could not save the lobby server');
    if (saved) setLobby(saved.guildId);
  }

  const mine = Object.values(guilds).sort((a, b) => a.name.localeCompare(b.name));
  const foreign = lobby && !guilds[lobby];

  return (
    <SettingsPage title="Lobby server" back="/settings/user">
      <p className="settings-lead">
        New people who sign in for the first time join the lobby server automatically. With none
        selected they start with no servers and find others under All members on Home. Changing it
        does not move anyone who has already signed in.
      </p>
      <SettingsCard title="Lobby">
        {lobby !== undefined && (
          <label className="field">
            <span>Server new users join</span>
            <select value={lobby ?? ''} onChange={(event) => void choose(event.target.value)}>
              <option value="">None (new users join no server)</option>
              {foreign && <option value={lobby}>A server you are not in</option>}
              {mine.map((guild) => (
                <option key={guild.id} value={guild.id}>
                  {guild.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}
