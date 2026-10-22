import { api } from '../../api/client.js';
import { PinIcon } from '../../components/Icons.js';
import { attempt } from '../../store/actions.js';
import { appStore } from '../../store/store.js';
import { defineWebModule } from '../types.js';
import { PinsPopover } from './PinsPopover.js';

export const pins = defineWebModule({
  id: 'pins',
  channelHeaderActions: PinsPopover,
  messageActions: [
    {
      id: 'toggle',
      icon: PinIcon,
      label: (message) => (message.pinnedAt ? 'Unpin message' : 'Pin message'),
      onSelect: (message) => {
        void attempt(
          message.pinnedAt ? api.unpin(message.id) : api.pin(message.id),
          'Could not change the pin',
        ).then((updated) => {
          if (updated)
            appStore.getState().applyFrame({ type: 'message.updated', message: updated });
        });
      },
    },
  ],
});
