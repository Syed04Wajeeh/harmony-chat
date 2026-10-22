import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  isDesktopApp,
  notificationFor,
  notifyDesktop,
  onDesktopNavigate,
  parseRoute,
  setDesktopBadge,
} from '../lib/desktopBridge.js';
import { getRealtime } from '../store/connection.js';
import { jumpToMessage } from '../store/actions.js';
import { mentionTotal } from '../store/selectors.js';
import { appStore, useApp } from '../store/store.js';

/** Connects the app to the desktop shell: unread badge, native notifications, click-through. */
export function DesktopBridge() {
  const channels = useApp((state) => state.channels);
  const total = mentionTotal(Object.values(channels));
  const navigate = useNavigate();
  const desktop = isDesktopApp();

  useEffect(() => {
    if (desktop) setDesktopBadge(total);
  }, [desktop, total]);

  useEffect(() => {
    if (!desktop) return;
    return getRealtime().onFrame((frame) => {
      if (frame.type !== 'message.created' || document.hasFocus()) return;
      const { channels: known, users, me } = appStore.getState();
      const notification = notificationFor(
        frame.message,
        known[frame.message.channelId],
        me?.id,
        (id) => users[id]?.displayName,
      );
      if (notification) notifyDesktop(notification);
    });
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    return onDesktopNavigate((route) => {
      const { path, channelId, messageId } = parseRoute(route);
      void navigate(path);
      if (channelId && messageId) void jumpToMessage(channelId, messageId);
    });
  }, [desktop, navigate]);

  return null;
}
