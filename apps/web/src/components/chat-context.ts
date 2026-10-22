import type { Attachment, Message } from '@harmony/shared';
import { createContext, useContext } from 'react';

export interface MessageHandlers {
  meId: string;
  nameOf: (userId: string) => string | undefined;
  editingId: string | null;
  highlightId: string | null;
  onReply: (message: Message) => void;
  onStartEdit: (message: Message) => void;
  onCancelEdit: () => void;
  onSaveEdit: (message: Message, content: string) => Promise<void>;
  onDelete: (message: Message) => void;
  onCopy: (message: Message) => void;
  onOpenSheet: (message: Message) => void;
  onJump: (messageId: string) => void;
  onOpenImage: (attachment: Attachment) => void;
}

export const MessageContext = createContext<MessageHandlers | null>(null);

export function useMessageHandlers(): MessageHandlers {
  const value = useContext(MessageContext);
  if (!value) throw new Error('MessageContext is missing');
  return value;
}
