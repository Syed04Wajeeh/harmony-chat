import { useEffect } from 'react';
import { api } from '../../api/client.js';
import { attempt, loadChannelMembers, loadGuildMembers } from '../../store/actions.js';
import { useApp } from '../../store/store.js';
import { Avatar } from '../Avatar.js';
import { Modal } from '../Overlay.js';

interface Props {
  channelId: string;
  guildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddMembersDialog({ channelId, guildId, open, onOpenChange }: Props) {
  const users = useApp((state) => state.users);
  const guildMembers = useApp((state) => state.guildMembers[guildId]);
  const channelMembers = useApp((state) => state.channelMembers[channelId]);

  useEffect(() => {
    if (!open) return;
    void loadGuildMembers(guildId);
    void loadChannelMembers(channelId);
  }, [open, guildId, channelId]);

  const inChannel = new Set(channelMembers);
  const candidates = (guildMembers ?? []).filter((id) => !inChannel.has(id));

  async function add(userId: string) {
    await attempt(api.addChannelMember(channelId, userId), 'Could not add that person');
    await loadChannelMembers(channelId);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add people"
      description="Pick server members to give access to this private channel."
    >
      <ul className="picker-list">
        {candidates.map((id) => {
          const user = users[id];
          return user ? (
            <li key={id}>
              <Avatar user={user} size={36} />
              <span className="picker-name">{user.displayName}</span>
              <button className="button" onClick={() => void add(id)}>
                Add
              </button>
            </li>
          ) : null;
        })}
        {candidates.length === 0 && (
          <li className="empty-note">Everyone is already in this channel.</li>
        )}
      </ul>
    </Modal>
  );
}
