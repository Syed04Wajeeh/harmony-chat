import type { Message } from '@harmony/shared';
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { api } from '../api/client.js';
import { useCoarsePointer } from '../hooks/useMediaQuery.js';
import { useNameOf } from '../hooks/useNameOf.js';
import { useUploads } from '../hooks/useUploads.js';
import { useWindowFocus } from '../hooks/useWindowFocus.js';
import { HOME } from '../lib/paths.js';
import { rememberChannel } from '../lib/storage.js';
import { decodeMentions } from '../lib/mentions.js';
import { buildTimeline } from '../lib/timeline.js';
import { firstUnreadId, shouldMarkRead } from '../lib/unread.js';
import {
  attempt,
  discardOutbox,
  jumpToMessage,
  loadLatest,
  loadOlder,
  markRead,
  retryOutbox,
} from '../store/actions.js';
import type { LocalInteraction } from '../store/interactions.js';
import { appStore, useApp } from '../store/store.js';
import { useUi } from '../store/ui.js';
import { Lightbox } from './Attachments.js';
import { ChannelHeader } from './ChannelHeader.js';
import { MessageContext, type MessageHandlers } from './chat-context.js';
import { useGuildAccess } from '../hooks/usePermission.js';
import { Composer } from './Composer.js';
import { ChannelPanels } from '../modules/slots.js';
import { MessageList, type PendingMessage } from './MessageList.js';
import { MessageSheet } from './MessageSheet.js';
import { ConfirmDialog } from './Overlay.js';
import { TypingIndicator } from './TypingIndicator.js';
import type { Attachment } from '@harmony/shared';

const NO_INTERACTIONS: readonly LocalInteraction[] = [];

export function ChannelView({ channelId }: { channelId: string }) {
  const channel = useApp((state) => state.channels[channelId]);
  const access = useGuildAccess(channel?.guildId ?? '', channel?.guildId ? channelId : undefined);
  const readOnly = channel?.guildId != null && access.loaded && !access.has('send_messages');
  const history = useApp((state) => state.history[channelId]);
  const outbox = useApp((state) => state.outbox[channelId]);
  const interactions = useApp((state) => state.interactions[channelId]) ?? NO_INTERACTIONS;
  const me = useApp((state) => state.me);
  const users = useApp((state) => state.users);
  const guildMembers = useApp((state) =>
    channel?.guildId ? state.guildMembers[channel.guildId] : undefined,
  );
  const channelMembers = useApp((state) => state.channelMembers[channelId]);
  const jump = useUi((state) => state.jump);
  const nameOf = useNameOf();
  const coarse = useCoarsePointer();
  const focused = useWindowFocus();
  const uploads = useUploads();

  const [atBottom, setAtBottom] = useState(true);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Message | null>(null);
  const [sheet, setSheet] = useState<Message | null>(null);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const highlightId = useUi((state) => state.highlightId);
  const [dragging, setDragging] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Frozen when the channel opens so the divider stays put while the marker advances.
  const [openedAt] = useState(() => ({
    lastRead: channel?.lastReadMessageId ?? null,
    hadUnread: (channel?.unreadCount ?? 0) > 0,
  }));

  const loaded = history?.loaded ?? false;
  const messages = useMemo(() => history?.messages ?? [], [history?.messages]);
  const hasMore = history?.hasMore ?? false;
  const newest = messages.at(-1)?.id ?? null;

  useEffect(() => {
    const store = appStore.getState();
    store.setActiveChannel(channelId);
    store.openHistory(channelId);
    return () => {
      appStore.getState().setActiveChannel(null);
      useUi.getState().setChannelPanel(null);
    };
  }, [channelId]);

  useEffect(() => {
    const timer = setInterval(() => appStore.getState().pruneInteractions(), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (channel) rememberChannel(channel.guildId ?? HOME, channelId);
  }, [channel, channelId]);

  useEffect(() => {
    if (!loaded) void loadLatest(channelId);
  }, [loaded, channelId]);

  const lastRead = channel?.lastReadMessageId ?? null;
  useEffect(() => {
    appStore.getState().setFollowing(atBottom && focused ? channelId : null);
    return () => appStore.getState().setFollowing(null);
  }, [atBottom, focused, channelId]);

  useEffect(() => {
    if (!shouldMarkRead({ newestId: newest, lastReadId: lastRead, atBottom, focused }) || !newest)
      return;
    const timer = setTimeout(() => void markRead(channelId, newest), 400);
    return () => clearTimeout(timer);
  }, [newest, lastRead, atBottom, focused, channelId]);

  const unreadFromId = useMemo(
    () =>
      firstUnreadId(messages, openedAt.hadUnread ? openedAt.lastRead : null, me?.id ?? '', hasMore),
    [messages, openedAt, me?.id, hasMore],
  );
  const items = useMemo(() => buildTimeline(messages, { unreadFromId }), [messages, unreadFromId]);

  const pending = useMemo<PendingMessage[]>(() => {
    if (!me) return [];
    return (outbox ?? []).map((item) => {
      const parent = item.replyToId ? messages.find((m) => m.id === item.replyToId) : undefined;
      return {
        item,
        message: {
          id: `pending-${item.nonce}`,
          channelId,
          author: me,
          content: item.content,
          createdAt: item.createdAt,
          editedAt: null,
          deleted: false,
          pinnedAt: null,
          pinnedBy: null,
          replyTo: parent
            ? {
                id: parent.id,
                authorId: parent.author.id,
                contentPreview: parent.content.slice(0, 100),
                deleted: false,
              }
            : null,
          reactions: [],
          attachments: [...item.attachments],
          mentions: [],
        },
      };
    });
  }, [outbox, me, channelId, messages]);

  // Jump requests (search results, pins, reply quotes) once the target is rendered.
  useEffect(() => {
    if (!jump || jump.channelId !== channelId || !loaded) return;
    const el = document.getElementById(`m-${jump.messageId}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    useUi.getState().completeJump(jump.messageId);
  }, [jump, channelId, loaded, items.length]);

  const handleLoadOlder = useCallback(() => {
    setLoadingOlder(true);
    void loadOlder(channelId).finally(() => setLoadingOlder(false));
  }, [channelId]);

  const handlers = useMemo<MessageHandlers>(
    () => ({
      meId: me?.id ?? '',
      nameOf,
      editingId,
      highlightId,
      onReply: setReplyTo,
      onStartEdit: (message) => setEditingId(message.id),
      onCancelEdit: () => setEditingId(null),
      onSaveEdit: async (message, content) => {
        const updated = await attempt(
          api.editMessage(message.id, content),
          'Could not edit the message',
        );
        if (updated) {
          appStore.getState().applyFrame({ type: 'message.updated', message: updated });
          setEditingId(null);
        }
      },
      onDelete: setDeleting,
      onCopy: (message) => {
        const text = decodeMentions(message.content, nameOf).text;
        navigator.clipboard
          .writeText(text)
          .then(() => useUi.getState().pushToast('Copied to clipboard', 'info'))
          .catch(() => useUi.getState().pushToast('Could not copy'));
      },
      onOpenSheet: setSheet,
      onJump: (messageId) => void jumpToMessage(channelId, messageId),
      onOpenImage: setLightbox,
    }),
    [me?.id, nameOf, editingId, highlightId, channelId],
  );

  const editLast = useCallback(() => {
    const own = [...messages].reverse().find((m) => !m.deleted && m.author.id === me?.id);
    if (own) setEditingId(own.id);
  }, [messages, me?.id]);

  const candidates = useMemo(() => {
    const ids = channel?.isPrivate ? channelMembers : guildMembers;
    const pool = ids ? ids.flatMap((id) => (users[id] ? [users[id]] : [])) : Object.values(users);
    return pool.filter((user) => user.id !== me?.id);
  }, [channel?.isPrivate, channelMembers, guildMembers, users, me?.id]);

  if (!channel || !me) return null;
  const isDm = channel.kind === 'dm';
  const label = isDm ? (channel.dmUser?.displayName ?? 'conversation') : `#${channel.name ?? ''}`;

  const onDragOver = (event: DragEvent) => {
    if (coarse || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    setDragging(false);
    uploads.add([...event.dataTransfer.files]);
  };

  return (
    <MessageContext.Provider value={handlers}>
      <section
        className="channel-view"
        aria-label={label}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={(event) => event.currentTarget === event.target && setDragging(false)}
        onDrop={onDrop}
      >
        <ChannelHeader channel={channel} />
        <div className="channel-body">
          <MessageList
            items={items}
            pending={pending}
            interactions={interactions}
            channelId={channelId}
            loaded={loaded}
            hasMore={hasMore}
            loadingOlder={loadingOlder}
            onLoadOlder={handleLoadOlder}
            onBottomChange={setAtBottom}
            onRetry={(item) => retryOutbox(channelId, item.nonce)}
            onDiscard={(item) => discardOutbox(channelId, item.nonce)}
            empty={
              <div className="empty-state">
                <h2>
                  {isDm ? `This is the start of your chat with ${label}` : `Welcome to ${label}`}
                </h2>
                <p>
                  {isDm
                    ? 'Say hello.'
                    : (channel.topic ?? 'This is the start of the channel. Say hello.')}
                </p>
              </div>
            }
          />
          <ChannelPanels channelId={channelId} label={label} />
        </div>
        <TypingIndicator channelId={channelId} />
        {readOnly ? (
          <p className="composer-locked" role="status">
            You do not have permission to send messages in this channel.
          </p>
        ) : (
          <Composer
            key={channelId}
            channelId={channelId}
            guildId={channel.guildId}
            placeholder={isDm ? `Message ${label}` : `Message ${label}`}
            replyTo={replyTo}
            replyToName={replyTo ? (nameOf(replyTo.author.id) ?? replyTo.author.displayName) : null}
            onCancelReply={() => setReplyTo(null)}
            onEditLast={editLast}
            uploads={uploads}
            candidates={candidates}
            me={me}
          />
        )}
        {dragging && <div className="drop-overlay">Drop files to upload</div>}
      </section>
      <MessageSheet message={sheet} onClose={() => setSheet(null)} />
      <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete message?"
        description="This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void attempt(api.deleteMessage(target.id), 'Could not delete the message');
        }}
      />
    </MessageContext.Provider>
  );
}
