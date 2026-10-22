import { decodeMentions } from './mentions.js';
import type { ChannelSummary, Message } from '@harmony/shared';
import { channelPath } from './paths.js';

/** Dispatched on `window` by the desktop shell when the user clicks a notification. */
export const NAVIGATE_EVENT = 'harmony-desktop:navigate';

const MAX_TITLE = 100;
const MAX_BODY = 300;
/** Older messages arrive in a reconnect backfill and are not worth a popup. */
const FRESH_MS = 5 * 60 * 1000;

interface TauriInternals {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

export const isDesktopApp = (): boolean => window.__TAURI_INTERNALS__ !== undefined;

function call(command: string, args: Record<string, unknown>): void {
  window.__TAURI_INTERNALS__?.invoke(command, args).catch(() => undefined);
}

export interface DesktopNotification {
  title: string;
  body: string;
  route: string;
}

export function notifyDesktop(notification: DesktopNotification): void {
  call('notify', { ...notification });
}

export function setDesktopBadge(count: number): void {
  call('set_badge', { count });
}

/** Calls `handler` with the route of a clicked notification. */
export function onDesktopNavigate(handler: (route: string) => void): () => void {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent && typeof event.detail === 'string') handler(event.detail);
  };
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => window.removeEventListener(NAVIGATE_EVENT, listener);
}

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The notification for a new message, or null when it should not interrupt anyone. */
export function notificationFor(
  message: Message,
  channel: ChannelSummary | undefined,
  meId: string | undefined,
  nameOf: (userId: string) => string | undefined,
  now = Date.now(),
): DesktopNotification | null {
  if (!channel || !meId || message.deleted || message.author.id === meId) return null;
  if (now - Date.parse(message.createdAt) > FRESH_MS) return null;
  const isDm = channel.kind === 'dm';
  if (!isDm && !message.mentions.includes(meId)) return null;

  const author = message.displayNameOverride ?? message.author.displayName;
  const text = decodeMentions(message.content, nameOf).text.trim();
  const body = text || (message.attachments.length > 0 ? 'Sent an attachment' : '');
  return {
    title: truncate(isDm ? author : `${author} in #${channel.name ?? 'channel'}`, MAX_TITLE),
    body: truncate(body, MAX_BODY),
    route: `${channelPath(channel)}?message=${message.id}`,
  };
}

/** Splits a notification route into the page to open and the message to scroll to, if any. */
export function parseRoute(route: string): {
  path: string;
  channelId?: string;
  messageId?: string;
} {
  const url = new URL(route, 'http://localhost');
  const [, section, , channelId] = url.pathname.split('/');
  const messageId = url.searchParams.get('message') ?? undefined;
  return {
    path: url.pathname,
    ...(section === 'channels' && channelId && messageId && { channelId, messageId }),
  };
}

/** The releases page set at build time, or null when this build does not advertise one. */
export function releasesUrl(raw: unknown = import.meta.env['VITE_RELEASES_URL']): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
