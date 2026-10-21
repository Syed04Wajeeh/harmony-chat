import type { Message } from '@harmony/shared';

export interface OutboxItem {
  nonce: string;
  content: string;
  createdAt: string;
  status: 'pending' | 'failed';
}

export interface ChatState {
  messages: Message[];
  outbox: OutboxItem[];
  hasMore: boolean;
  loaded: boolean;
}

export type ChatAction =
  | { type: 'reset' }
  | { type: 'loaded'; messages: Message[]; hasMore: boolean }
  | { type: 'older'; messages: Message[]; hasMore: boolean }
  | { type: 'received'; messages: Message[]; nonce?: string }
  | { type: 'queued'; item: OutboxItem }
  | { type: 'acked'; nonce: string; message: Message }
  | { type: 'failed'; nonce?: string };

export const initialChatState: ChatState = {
  messages: [],
  outbox: [],
  hasMore: false,
  loaded: false,
};

const compareIds = (a: string, b: string): number => {
  const diff = BigInt(a) - BigInt(b);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
};

/** Union by id, ordered by id. Live, backfilled and fetched messages can all overlap. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return initialChatState;
    case 'loaded':
      return {
        ...state,
        messages: mergeMessages(state.messages, action.messages),
        hasMore: action.hasMore,
        loaded: true,
      };
    case 'older':
      return {
        ...state,
        messages: mergeMessages(state.messages, action.messages),
        hasMore: action.hasMore,
      };
    case 'received':
      return {
        ...state,
        messages: mergeMessages(state.messages, action.messages),
        outbox: action.nonce
          ? state.outbox.filter((item) => item.nonce !== action.nonce)
          : state.outbox,
      };
    case 'queued':
      return { ...state, outbox: [...state.outbox, action.item] };
    case 'acked':
      return {
        ...state,
        messages: mergeMessages(state.messages, [action.message]),
        outbox: state.outbox.filter((item) => item.nonce !== action.nonce),
      };
    case 'failed':
      return {
        ...state,
        outbox: state.outbox.map((item) =>
          item.status === 'pending' && (action.nonce === undefined || item.nonce === action.nonce)
            ? { ...item, status: 'failed' }
            : item,
        ),
      };
  }
}

export function lastSeenId(messages: Message[]): string | undefined {
  return messages.at(-1)?.id;
}
