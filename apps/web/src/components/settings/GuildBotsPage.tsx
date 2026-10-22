import type { Bot, DirectoryUser } from '@harmony/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client.js';
import { attempt, reportError } from '../../store/actions.js';
import { Avatar } from '../Avatar.js';
import { PlusIcon, TrashIcon } from '../Icons.js';
import { ConfirmDialog, Modal } from '../Overlay.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

function AddBotDialog({
  open,
  onOpenChange,
  inServer,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inServer: ReadonlySet<string>;
  onAdd: (bot: Bot) => Promise<void>;
}) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    api
      .bots(controller.signal)
      .then(setBots)
      .catch((error: unknown) => reportError(error, 'Could not load your bots'));
    return () => controller.abort();
  }, [open]);

  const available = (bots ?? []).filter((bot) => !inServer.has(bot.id));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add a bot"
      description="Choose one of your bots to add to this server."
    >
      {bots === null ? (
        <p className="empty-note" role="status">
          Loading…
        </p>
      ) : available.length === 0 ? (
        <p className="empty-note">
          {bots.length === 0 ? 'You have no bots yet. ' : 'All your bots are already here. '}
          <Link to="/settings/user/bots">Manage your bots</Link>
        </p>
      ) : (
        <ul className="picker-list" aria-label="Your bots">
          {available.map((bot) => (
            <li key={bot.id}>
              <Avatar
                user={{ id: bot.id, displayName: bot.name, avatarUrl: bot.avatarUrl }}
                size={36}
              />
              <span className="picker-name">{bot.name}</span>
              <button
                type="button"
                className="button"
                disabled={adding !== null}
                aria-label={`Add ${bot.name}`}
                onClick={() => {
                  setAdding(bot.id);
                  void onAdd(bot).finally(() => setAdding(null));
                }}
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function GuildBotsPage() {
  const { guildId = '' } = useParams();
  const [members, setMembers] = useState<DirectoryUser[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DirectoryUser | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      api
        .guildMembers(guildId, signal)
        .then(setMembers)
        .catch((error: unknown) => reportError(error, "Could not load the server's bots")),
    [guildId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const bots = (members ?? []).filter((member) => member.isBot);

  async function add(bot: Bot) {
    const added = await attempt(
      api.addGuildBot(guildId, bot.id).then(() => true),
      `Could not add ${bot.name}`,
    );
    if (added) {
      await load();
      setAdding(false);
    }
  }

  async function remove(bot: DirectoryUser) {
    setRemoving(null);
    const removed = await attempt(
      api.removeGuildBot(guildId, bot.id).then(() => true),
      `Could not remove ${bot.displayName}`,
    );
    if (removed) setMembers((current) => (current ?? []).filter((member) => member.id !== bot.id));
  }

  return (
    <SettingsPage title="Bots" back={`/settings/server/${guildId}`}>
      <SettingsCard
        title="Bots in this server"
        description="Bots are members: they only see the channels they can access and need their own scopes. You can add bots you created."
      >
        <div className="settings-toolbar">
          <button type="button" className="button button-primary" onClick={() => setAdding(true)}>
            <PlusIcon width={18} height={18} /> Add bot
          </button>
        </div>
        {members === null ? (
          <p className="empty-note" role="status">
            Loading…
          </p>
        ) : bots.length === 0 ? (
          <p className="empty-note">No bots in this server yet.</p>
        ) : (
          <ul className="settings-list" aria-label="Bots in this server">
            {bots.map((bot) => (
              <li key={bot.id} className="settings-row">
                <Avatar user={bot} size={40} />
                <span className="settings-row-text">
                  <span className="settings-row-title">{bot.displayName}</span>
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${bot.displayName}`}
                  onClick={() => setRemoving(bot)}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
      <AddBotDialog
        open={adding}
        onOpenChange={setAdding}
        inServer={new Set(bots.map((bot) => bot.id))}
        onAdd={add}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.displayName ?? 'bot'}?`}
        description="It loses access to this server and its slash commands here are removed."
        confirmLabel="Remove bot"
        danger
        onConfirm={() => removing && void remove(removing)}
      />
    </SettingsPage>
  );
}
