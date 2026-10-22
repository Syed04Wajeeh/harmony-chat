import type { Attachment, Message, OptionValue, UserStatus } from '@harmony/shared';
import { api, ApiError } from '../api/client.js';
import { describeError } from '../lib/errors.js';
import { compareIds } from '../lib/ids.js';
import { appStore, type OutboxItem } from './store.js';
import { useUi } from './ui.js';
import { getRealtime } from './connection.js';

const PAGE_SIZE = 50;
const MAX_JUMP_PAGES = 20;

export function reportError(error: unknown, fallback = 'Something went wrong'): void {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  let message = fallback;
  if (error instanceof ApiError) {
    message = describeError(error.code, error.message);
  } else if (error instanceof TypeError) {
    message = 'Cannot reach the server';
  }
  useUi.getState().pushToast(message);
}

/** Runs an action and reports a failure as a toast; resolves to undefined on failure. */
export async function attempt<T>(work: Promise<T>, fallback?: string): Promise<T | undefined> {
  try {
    return await work;
  } catch (error) {
    reportError(error, fallback);
    return undefined;
  }
}

export async function fetchSnapshot(signal?: AbortSignal) {
  const [me, guilds, channels, presence, users] = await Promise.all([
    api.me(signal),
    api.guilds(signal),
    api.channels(signal),
    api.presence(signal),
    api.users(signal),
  ]);
  return { me, snapshot: { guilds, channels, presence, users } };
}

export async function bootstrap(signal?: AbortSignal): Promise<void> {
  const { me, snapshot } = await fetchSnapshot(signal);
  appStore.getState().loadSnapshot(snapshot, me);
}

const loading = new Set<string>();

/** Fetches the newest page of a channel and merges it with what is cached. */
export async function loadLatest(channelId: string): Promise<void> {
  if (loading.has(channelId)) return;
  loading.add(channelId);
  try {
    const page = await api.messages(channelId, { limit: PAGE_SIZE });
    appStore.getState().historyLoaded(channelId, page.messages, page.hasMore);
  } catch (error) {
    reportError(error, 'Could not load messages');
  } finally {
    loading.delete(channelId);
  }
}

export async function loadOlder(channelId: string): Promise<boolean> {
  const key = `older:${channelId}`;
  const history = appStore.getState().history[channelId];
  const oldest = history?.messages[0];
  if (!history || !oldest || !history.hasMore || loading.has(key)) return false;
  loading.add(key);
  try {
    const page = await api.messages(channelId, { before: oldest.id, limit: PAGE_SIZE });
    appStore.getState().historyOlder(channelId, page.messages, page.hasMore);
    return true;
  } catch (error) {
    reportError(error, 'Could not load older messages');
    return false;
  } finally {
    loading.delete(key);
  }
}

/** Pages backwards until the message is cached. Resolves to whether it is now available. */
export async function ensureMessageLoaded(channelId: string, messageId: string): Promise<boolean> {
  const store = appStore.getState();
  store.openHistory(channelId);
  if (!appStore.getState().history[channelId]?.loaded) await loadLatest(channelId);

  for (let page = 0; page < MAX_JUMP_PAGES; page++) {
    const history = appStore.getState().history[channelId];
    if (!history) return false;
    if (history.messages.some((message) => message.id === messageId)) return true;
    const oldest = history.messages[0];
    if (!oldest || !history.hasMore || compareIds(messageId, oldest.id) > 0) return false;
    if (!(await loadOlder(channelId))) return false;
  }
  return false;
}

/** Navigation-agnostic jump: loads history if needed, then asks the list to scroll. */
export async function jumpToMessage(channelId: string, messageId: string): Promise<void> {
  if (await ensureMessageLoaded(channelId, messageId)) {
    useUi.getState().requestJump(channelId, messageId);
  } else {
    useUi.getState().pushToast('That message is too far back to jump to', 'info');
  }
}

export function sendMessage(options: {
  channelId: string;
  content: string;
  replyToId?: string | null;
  attachments?: readonly Attachment[];
  nonce?: string;
}): void {
  const { channelId, content, replyToId = null, attachments = [] } = options;
  const item: OutboxItem = {
    nonce: options.nonce ?? crypto.randomUUID(),
    channelId,
    content,
    replyToId,
    attachments,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  appStore.getState().queueOutbox(item);
  transmit(item);
}

function transmit(item: OutboxItem): void {
  const sent = getRealtime().send({
    type: 'message.send',
    channelId: item.channelId,
    content: item.content,
    nonce: item.nonce,
    ...(item.replyToId && { replyToId: item.replyToId }),
    ...(item.attachments.length > 0 && { attachmentIds: item.attachments.map((a) => a.id) }),
  });
  if (!sent) appStore.getState().failOutbox(item.nonce, 'Not connected');
}

/** Runs a slash command; the outcome comes back as a message or an `interaction.*` frame. */
export function invokeCommand(
  channelId: string,
  name: string,
  options: Record<string, OptionValue>,
): boolean {
  const sent = getRealtime().send({
    type: 'command.invoke',
    channelId,
    name,
    options,
    nonce: crypto.randomUUID(),
  });
  if (!sent) useUi.getState().pushToast('Not connected. Try again in a moment.');
  return sent;
}

export function retryOutbox(channelId: string, nonce: string): void {
  const item = appStore
    .getState()
    .outbox[channelId]?.find((candidate) => candidate.nonce === nonce);
  if (!item) return;
  appStore.getState().removeOutbox(channelId, nonce);
  sendMessage({ ...item, nonce: crypto.randomUUID() });
}

export function discardOutbox(channelId: string, nonce: string): void {
  appStore.getState().removeOutbox(channelId, nonce);
}

export async function toggleReaction(message: Message, emoji: string): Promise<void> {
  const me = appStore.getState().me;
  if (!me) return;
  const mine = message.reactions.find((r) => r.emoji === emoji)?.userIds.includes(me.id) ?? false;
  await attempt(mine ? api.removeReaction(message.id, emoji) : api.addReaction(message.id, emoji));
}

export async function markRead(channelId: string, messageId: string): Promise<void> {
  try {
    appStore.getState().applyReadState(await api.markRead(channelId, messageId));
  } catch {
    // Read state is best effort; the next scroll or event retries.
  }
}

export async function changeStatus(status: UserStatus): Promise<void> {
  const me = await attempt(api.setStatus(status));
  if (me) appStore.getState().setMe(me);
}

export async function openDm(userId: string) {
  const channel = await attempt(api.openDm(userId));
  if (channel) appStore.getState().upsertChannel(channel);
  return channel;
}

/** Loads the guild's channels (needed after joining, when the snapshot predates it). */
export async function loadGuildChannels(guildId: string): Promise<void> {
  const channels = await attempt(api.guildChannels(guildId));
  for (const channel of channels ?? []) appStore.getState().upsertChannel(channel);
}

export async function loadGuildMembers(guildId: string): Promise<void> {
  try {
    appStore.getState().setGuildMembers(guildId, await api.guildMembers(guildId));
  } catch (error) {
    reportError(error, 'Could not load members');
  }
}

/** Which modules are on in a guild, and their settings. Needed once per guild per session. */
export async function loadGuildModules(guildId: string): Promise<void> {
  try {
    appStore.getState().setGuildModules(guildId, await api.guildModules(guildId));
  } catch (error) {
    reportError(error, "Could not load the server's modules");
  }
}

export async function loadChannelMembers(channelId: string): Promise<void> {
  try {
    appStore.getState().setChannelMembers(channelId, await api.channelMembers(channelId));
  } catch (error) {
    reportError(error, 'Could not load members');
  }
}

export async function loadRoles(guildId: string): Promise<void> {
  try {
    appStore.getState().setRoles(guildId, await api.roles(guildId));
  } catch (error) {
    reportError(error, 'Could not load roles');
  }
}

const permissionLoads = new Set<string>();

/** What the signed-in user may do in the guild, or in one of its channels. */
export async function loadPermissions(guildId: string, channelId?: string): Promise<void> {
  const key = `${guildId}:${channelId ?? ''}`;
  if (permissionLoads.has(key)) return;
  permissionLoads.add(key);
  try {
    const permissions = await api.permissions(guildId, channelId);
    appStore.getState().setPermissions(guildId, permissions, channelId);
  } catch {
    // Not fatal: controls stay hidden and the server still enforces everything.
  } finally {
    permissionLoads.delete(key);
  }
}

/** Re-reads every permission set in view, after a role, nickname or overwrite change. */
export function refreshPermissions(): void {
  const { guildPermissions, channelPermissions, channels } = appStore.getState();
  for (const guildId of Object.keys(guildPermissions)) void loadPermissions(guildId);
  for (const channelId of Object.keys(channelPermissions)) {
    const guildId = channels[channelId]?.guildId;
    if (guildId) void loadPermissions(guildId, channelId);
  }
}

export async function loadOverwrites(channelId: string): Promise<void> {
  try {
    appStore.getState().setOverwrites(channelId, await api.overwrites(channelId));
  } catch (error) {
    reportError(error, 'Could not load channel permissions');
  }
}
