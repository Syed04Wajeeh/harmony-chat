import type { RealtimeClient } from '../api/realtime.js';
import { describeError } from '../lib/errors.js';
import {
  fetchSnapshot,
  loadGuildModules,
  loadLatest,
  refreshPermissions,
  refreshPresence,
  reportError,
} from './actions.js';
import { routeModuleFrame } from '../modules/registry.js';
import { getRealtime } from './connection.js';
import { useProfiles } from './profiles.js';
import { loadSettings, useSettings } from './settings.js';
import { appStore } from './store.js';
import { useUi } from './ui.js';

/** Frames after which what the user may do could have changed. */
const PERMISSION_FRAMES = new Set<string>([
  'guild.role_created',
  'guild.role_updated',
  'guild.role_deleted',
  'guild.member_updated',
  'channel.overwrites_updated',
  'guild.updated',
]);

/** Subscribing to every channel is a burst of frames; stay under the socket's token bucket. */
const SUBSCRIBE_BURST = 15;
const SUBSCRIBE_INTERVAL_MS = 400;
/** Several membership frames in a row (leaving a guild removes each of its channels) refetch once. */
const PRESENCE_REFRESH_DEBOUNCE_MS = 300;

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
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePresenceRefresh = (delay = PRESENCE_REFRESH_DEBOUNCE_MS) => {
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => void refreshPresence(), delay);
  };

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
      const { me, snapshot } = await fetchSnapshot(undefined, { presence: false });
      const { activeChannelId, history } = appStore.getState();
      // Edits and deletes while offline are not in a backfill: forget idle caches.
      for (const id of Object.keys(history))
        if (id !== activeChannelId) appStore.getState().dropHistory(id);
      appStore.getState().loadSnapshot(snapshot, me);
      // Another device may have changed settings while the socket was down.
      void loadSettings().catch(() => undefined);
      void useProfiles.getState().refresh();
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
    if (frame.type === 'settings.updated') useSettings.getState().receive(frame.settings);
    else if (frame.type === 'themes.updated') useSettings.getState().setThemes(frame.themes);
    if (frame.type === 'user.updated') {
      appStore.getState().ingestUsers([frame.user]);
      useProfiles.getState().userUpdated(frame.user.id, frame.profile);
    } else if (frame.type === 'guild.emoji_updated') {
      useProfiles.getState().emojiUpdated(frame.guildId, frame.emoji);
    }
    appStore.getState().applyFrame(frame);
    // The server joined this socket to the user's presence topics before `hello`, so a snapshot
    // fetched now plus the batches that follow cannot miss a change. Who can see whom also changes
    // with guild and DM membership, and when someone leaves a guild the user is in.
    if (frame.type === 'hello') void refreshPresence();
    else if (
      frame.type === 'guild.joined' ||
      frame.type === 'guild.removed' ||
      frame.type === 'guild.member_left' ||
      (frame.type === 'channel.joined' && frame.channel.kind === 'dm')
    ) {
      schedulePresenceRefresh();
    }
    if (frame.type === 'error') {
      // A nonce no queued message owns belongs to a rejected slash command.
      const rejectedCommand = frame.nonce !== undefined && !hasOutboxItem(frame.nonce);
      if (rejectedCommand || (!frame.nonce && frame.code === 'rate_limited')) {
        useUi.getState().pushToast(describeError(frame.code, frame.message));
      }
    }
    if (frame.type === 'channel.joined' || frame.type === 'guild.removed') syncSubscriptions();
    if (PERMISSION_FRAMES.has(frame.type)) refreshPermissions();
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
    clearTimeout(presenceTimer);
    realtime.stop();
  };
}
