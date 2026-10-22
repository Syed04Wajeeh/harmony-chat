import { useNavigate } from 'react-router';
import { SearchIcon } from '../../components/Icons.js';
import { channelPath } from '../../lib/paths.js';
import { jumpToMessage } from '../../store/actions.js';
import { appStore } from '../../store/store.js';
import { defineWebModule, type ChannelPanelProps } from '../types.js';
import { SearchPanel } from './SearchPanel.js';

function SearchPanelSlot({ channelId, channelLabel, onClose }: ChannelPanelProps) {
  const navigate = useNavigate();
  return (
    <SearchPanel
      channelId={channelId}
      channelLabel={channelLabel}
      onClose={onClose}
      onPick={(message) => {
        onClose();
        void jumpToMessage(message.channelId, message.id).then(() => {
          const target = appStore.getState().channels[message.channelId];
          if (target && target.id !== channelId) void navigate(channelPath(target));
        });
      }}
    />
  );
}

export const search = defineWebModule({
  id: 'search',
  channelPanel: { label: 'Search', icon: SearchIcon, Panel: SearchPanelSlot },
});
