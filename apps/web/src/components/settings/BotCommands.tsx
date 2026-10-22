import type { GuildCommand } from '@harmony/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { appStore, useApp } from '../../store/store.js';

interface GuildGroup {
  guildId: string;
  name: string;
  commands: GuildCommand[];
}

/** Read-only: the commands a bot has registered in the servers you are in. */
export function BotCommands({ botId }: { botId: string }) {
  const guildKey = useApp((state) => Object.keys(state.guilds).sort().join(','));
  const [groups, setGroups] = useState<GuildGroup[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const list = guildKey ? guildKey.split(',') : [];
    void Promise.all(
      list.map((guildId) =>
        api.guildCommands(guildId, controller.signal).then(
          (commands) => ({
            guildId,
            name: appStore.getState().guilds[guildId]?.name ?? guildId,
            commands: commands.filter((command) => command.botId === botId),
          }),
          () => null,
        ),
      ),
    ).then((result) => {
      if (!controller.signal.aborted) {
        setGroups(
          result.filter(
            (group): group is GuildGroup => group !== null && group.commands.length > 0,
          ),
        );
      }
    });
    return () => controller.abort();
  }, [botId, guildKey]);

  if (groups === null) {
    return (
      <p className="empty-note" role="status">
        Loading…
      </p>
    );
  }
  if (groups.length === 0) {
    return (
      <p className="empty-note">
        No commands registered in your servers yet. A bot registers them with a bulk overwrite once
        it is added to a server.
      </p>
    );
  }
  return (
    <div className="command-groups">
      {groups.map((group) => (
        <div key={group.guildId}>
          <h3 className="settings-subheading">{group.name}</h3>
          <ul className="settings-list">
            {group.commands.map((command) => (
              <li key={command.name} className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-title">
                    <code>/{command.name}</code>
                  </span>
                  <span className="settings-row-meta">{command.description}</span>
                  {command.options.length > 0 && (
                    <span className="option-chips">
                      {command.options.map((option) => (
                        <span key={option.name} className="option-chip" title={option.description}>
                          {option.name}
                          {option.required ? '*' : ''}: {option.type}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
