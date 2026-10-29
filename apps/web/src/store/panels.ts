import type { Panel, ServerFrame } from '@harmony/shared';
import { create } from 'zustand';
import { api } from '../api/client.js';

const byPosition = (a: Panel, b: Panel): number =>
  a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

/** Keeps the newer of two versions of the same panel; an equal or older one is ignored. */
export function mergePanel(list: readonly Panel[], panel: Panel): readonly Panel[] {
  const current = list.find((item) => item.id === panel.id);
  if (current && current.version >= panel.version) return list;
  const rest = list.filter((item) => item.id !== panel.id);
  return [...rest, panel].sort(byPosition);
}

/** How long a button waits for the bot before the client stops showing it as pending. */
export const ACTION_PENDING_MS = 20_000;

interface PanelsState {
  /** Panels per channel, in display order. Absent until the channel's panels were fetched. */
  byChannel: Record<string, readonly Panel[]>;
  /** Buttons waiting for the bot: `<source id>:<button id>` -> the click's nonce. */
  pending: Record<string, string>;

  /** Replaces a channel's list with a fetched one, keeping any newer version received live. */
  setPanels(channelId: string, panels: readonly Panel[]): void;
  receive(frame: Extract<ServerFrame, { type: 'panel.updated' | 'panel.deleted' }>): void;
  forget(channelId: string): void;
  startAction(key: string, nonce: string): void;
  /** The bot answered (or the click failed): stop the spinner of the click with this nonce. */
  finishAction(nonce: string): void;
}

export const usePanels = create<PanelsState>()((set) => ({
  byChannel: {},
  pending: {},

  setPanels: (channelId, panels) =>
    set((state) => {
      const known = state.byChannel[channelId] ?? [];
      let next: readonly Panel[] = [...panels].sort(byPosition);
      // A live frame may have overtaken the fetch; the higher version wins. A panel the fetch
      // does not list is gone (or was deleted while this client was offline).
      for (const panel of known) {
        const fetched = next.find((item) => item.id === panel.id);
        if (fetched && panel.version > fetched.version) {
          next = mergePanel(
            next.filter((item) => item.id !== panel.id),
            panel,
          );
        }
      }
      return { byChannel: { ...state.byChannel, [channelId]: next } };
    }),

  receive: (frame) =>
    set((state) => {
      if (frame.type === 'panel.updated') {
        const list = state.byChannel[frame.channelId] ?? [];
        const next = mergePanel(list, frame.panel);
        if (next === list && frame.channelId in state.byChannel) return state;
        return { byChannel: { ...state.byChannel, [frame.channelId]: next } };
      }
      const list = state.byChannel[frame.channelId];
      if (!list?.some((panel) => panel.id === frame.panelId)) return state;
      return {
        byChannel: {
          ...state.byChannel,
          [frame.channelId]: list.filter((panel) => panel.id !== frame.panelId),
        },
      };
    }),

  forget: (channelId) =>
    set((state) => {
      if (!(channelId in state.byChannel)) return state;
      return {
        byChannel: Object.fromEntries(
          Object.entries(state.byChannel).filter(([id]) => id !== channelId),
        ),
      };
    }),

  startAction: (key, nonce) => set((state) => ({ pending: { ...state.pending, [key]: nonce } })),

  finishAction: (nonce) =>
    set((state) => {
      const entry = Object.entries(state.pending).find(([, value]) => value === nonce);
      if (!entry) return state;
      return {
        pending: Object.fromEntries(Object.entries(state.pending).filter(([, n]) => n !== nonce)),
      };
    }),
}));

const inflight = new Set<string>();

/** Fetches a channel's panels; a failure leaves what is cached (panels are not critical). */
export async function loadPanels(channelId: string): Promise<void> {
  if (inflight.has(channelId)) return;
  inflight.add(channelId);
  try {
    usePanels.getState().setPanels(channelId, await api.panels(channelId));
  } catch {
    // The next frame or reconnect fills it in.
  } finally {
    inflight.delete(channelId);
  }
}

/** After a reconnect, frames may have been missed: refetch every channel that is cached. */
export function reloadPanels(): void {
  for (const channelId of Object.keys(usePanels.getState().byChannel)) void loadPanels(channelId);
}

export const panelsOf = (channelId: string) => (state: PanelsState) => state.byChannel[channelId];
