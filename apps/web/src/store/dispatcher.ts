import type { RealtimeClient } from '../api/realtime.js';
import { describeError } from '../lib/errors.js';
import { fetchSnapshot, loadGuildModules, loadLatest, reportError } from './actions.js';
import { routeModuleFrame } from '../modules/registry.js';
import { getRealtime } from './connection.js';
import { appStore } from './store.js';
import { useUi } from './ui.js';

/** Subscribing to every channel is a burst of frames; stay under the socket's token bucket. */
const SUBSCRIBE_BURST = 15;
const SUBSCRIBE_INTERVAL_MS = 400;

const hasOutboxItem = (nonce: string): boolean =>
  Object.values(appStore.getState().outbox).some((items) =>
    items.some((item) => item.nonce === nonce),
  );

/**
 * The single place where the socket meets the store: frames go into `applyFrame`, and
 * the set of channel subscriptions follows the set of channels the user can see.
 */
export function startDispatcher(realtime: RealtimeClient = getRealtime()): () => void {
  const subscribed = new Set<string>();
  const queue: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sentInBurst = 0;
  let hasConnected = false;

  const subscribeFrame = (channelId: string) => {
    const state = appStore.getState();
    const cached = state.history[channelId]?.messages.at(-1)?.id;
    const lastSeenId = cached ?? state.channels[channelId]?.lastMessageId ?? undefined;
    realtime.send({ type: 'subscribe', channelId, ...(lastSeenId && { lastSeenId }) });
  };

  const drain = () => {
    timer = undefined;
    const next = queue.shift();
    if (next === undefined) return;
    subscribeFrame(next);
    sentInBurst++;
    if (queue.length > 0) timer = setTimeout(drain, SUBSCRIBE_INTERVAL_MS);
  };

  const syncSubscriptions = () => {
    if (realtime.status !== 'open') return;
    const { channels, activeChannelId } = appStore.getState();
    const wanted = Object.keys(channels).filter((id) => !subscribed.has(id) && !queue.includes(id));
    // The channel on screen goes first.
    wanted.sort((a, b) => Number(b === activeChannelId) - Number(a === activeChannelId));
    for (const id of wanted) {
      subscribed.add(id);
      if (sentInBurst < SUBSCRIBE_BURST) {
        sentInBurst++;
        subscribeFrame(id);
      } else {
        queue.push(id);
      }
    }
    if (queue.length > 0 && timer === undefined) timer = setTimeout(drain, SUBSCRIBE_INTERVAL_MS);
    for (const id of subscribed) if (!(id in channels)) subscribed.delete(id);
  };

  const resync = async () => {
    try {
      const { me, snapshot } = await fetchSnapshot();
      const { activeChannelId, history } = appStore.getState();
      // Edits and deletes while offline are not in a backfill: forget idle caches.
      for (const id of Object.keys(history))
        if (id !== activeChannelId) appStore.getState().dropHistory(id);
      appStore.getState().loadSnapshot(snapshot, me);
      if (activeChannelId) void loadLatest(activeChannelId);
      // Module switches may have changed while the socket was down.
      for (const guildId of Object.keys(appStore.getState().guildModules)) {
        void loadGuildModules(guildId);
      }
    } catch (error) {
      reportError(error, 'Could not refresh after reconnecting');
    }
    syncSubscriptions();
  };

  const offStatus = realtime.onStatus((status) => {
    appStore.getState().setConnection(status);
    if (status === 'open') {
      subscribed.clear();
      queue.length = 0;
      sentInBurst = 0;
      if (hasConnected) void resync();
      else syncSubscriptions();
      hasConnected = true;
    } else {
      appStore.getState().failOutbox(undefined, 'Not connected');
    }
  });
  const offFrame = realtime.onFrame((frame) => {
    appStore.getState().applyFrame(frame);
    if (frame.type === 'error') {
      // A nonce no queued message owns belongs to a rejected slash command.
      const rejectedCommand = frame.nonce !== undefined && !hasOutboxItem(frame.nonce);
      if (rejectedCommand || (!frame.nonce && frame.code === 'rate_limited')) {
        useUi.getState().pushToast(describeError(frame.code, frame.message));
      }
    }
    if (frame.type === 'channel.joined' || frame.type === 'guild.removed') syncSubscriptions();
  });
  const offModuleFrame = realtime.onModuleFrame((frame) => {
    routeModuleFrame(frame);
  });
  const offStore = appStore.subscribe((state, previous) => {
    if (state.channels !== previous.channels) syncSubscriptions();
  });
  const refill = setInterval(() => {
    sentInBurst = Math.max(0, sentInBurst - 1);
  }, SUBSCRIBE_INTERVAL_MS);

  realtime.start();
  return () => {
    offStatus();
    offFrame();
    offModuleFrame();
    offStore();
    clearInterval(refill);
    clearTimeout(timer);
    realtime.stop();
  };
}
