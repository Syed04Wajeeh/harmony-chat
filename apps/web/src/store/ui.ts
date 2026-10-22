import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  kind: 'error' | 'info';
}

export interface JumpRequest {
  channelId: string;
  messageId: string;
  seq: number;
}

interface UiState {
  toasts: readonly Toast[];
  /** Mobile drawers; only one is open at a time. */
  drawer: 'left' | 'right' | null;
  membersOpen: boolean;
  jump: JumpRequest | null;
  highlightId: string | null;
  pushToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setDrawer: (drawer: UiState['drawer']) => void;
  setMembersOpen: (open: boolean) => void;
  requestJump: (channelId: string, messageId: string) => void;
  /** Consumes the pending jump and briefly highlights its target. */
  completeJump: (messageId: string) => void;
}

let nextToastId = 1;
let jumpSeq = 1;

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === '1';
  } catch {
    return fallback;
  }
}

export const useUi = create<UiState>()((set) => ({
  toasts: [],
  drawer: null,
  membersOpen: readFlag('harmony.members', true),
  jump: null,
  highlightId: null,
  pushToast: (message, kind = 'error') => {
    const id = nextToastId++;
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, message, kind }] }));
    setTimeout(() => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })), 6000);
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  setDrawer: (drawer) => set({ drawer }),
  setMembersOpen: (membersOpen) => {
    try {
      localStorage.setItem('harmony.members', membersOpen ? '1' : '0');
    } catch {
      // Storage can be unavailable; the preference just will not persist.
    }
    set({ membersOpen });
  },
  requestJump: (channelId, messageId) => set({ jump: { channelId, messageId, seq: jumpSeq++ } }),
  completeJump: (messageId) => {
    set({ jump: null, highlightId: messageId });
    setTimeout(
      () => set((state) => (state.highlightId === messageId ? { highlightId: null } : state)),
      2200,
    );
  },
}));
