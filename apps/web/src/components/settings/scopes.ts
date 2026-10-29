import type { BotScope, EventType } from '@harmony/shared';

export const SCOPE_INFO: Record<BotScope, { label: string; description: string }> = {
  'messages.read': {
    label: 'Read messages',
    description: 'Read history, search and pins, and subscribe to live messages.',
  },
  'messages.write': {
    label: 'Send messages',
    description: 'Send, edit, delete and pin messages, and show typing.',
  },
  'reactions.write': {
    label: 'Add reactions',
    description: 'Add and remove reactions on messages.',
  },
  'channels.read': {
    label: 'Read channels and members',
    description: 'List servers, channels, members and presence.',
  },
  commands: {
    label: 'Slash commands',
    description: 'Register commands and answer them. Required for an interactions URL.',
  },
  'panels.write': {
    label: 'Panels',
    description:
      'Publish dashboards: panels of charts, stats and tables in channels. Buttons on them also need an interactions URL.',
  },
  events: {
    label: 'Events',
    description:
      'Receive signed events at an events URL. Message and reaction events also need "Read messages".',
  },
};

export const EVENT_INFO: Record<EventType, string> = {
  'message.created': 'A message was sent',
  'message.updated': 'A message was edited or pinned',
  'message.deleted': 'A message was deleted',
  'reaction.added': 'A reaction was added',
  'reaction.removed': 'A reaction was removed',
  'guild.member_joined': 'Someone joined the server',
  'guild.member_left': 'Someone left the server',
};
