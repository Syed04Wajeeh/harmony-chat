import { Poll, PollsUpdatedFrame } from '@harmony/shared';
import { PollIcon } from '../../components/Icons.js';
import { defineFrame, defineWebModule } from '../types.js';
import { CreatePollDialog } from './CreatePollDialog.js';
import { PollCard } from './PollCard.js';

export const polls = defineWebModule<Poll>({
  id: 'polls',
  messageData: Poll,
  messageAccessory: PollCard,
  composerActions: [
    {
      id: 'create',
      icon: PollIcon,
      label: 'Create poll',
      permission: 'polls.create',
      onSelect: ({ openDialog }) => openDialog(CreatePollDialog),
    },
  ],
  frames: [
    defineFrame({
      type: 'polls.updated',
      schema: PollsUpdatedFrame,
      reduce: (frame, store) =>
        store.patchMessage(frame.channelId, frame.messageId, (message) => ({
          ...message,
          modules: { ...message.modules, polls: frame.poll },
        })),
    }),
  ],
});
