import type { Message } from '@harmony/shared';
import { ActionRow } from './ActionButton.js';

/** The buttons a bot attached to a message. */
export function MessageButtons({ message }: { message: Message }) {
  if (!message.components || message.deleted) return null;
  return (
    <ActionRow
      buttons={message.components.buttons}
      source={{ messageId: message.id }}
      channelId={message.channelId}
    />
  );
}
