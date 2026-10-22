import {
  TYPING_EXPIRY_MS,
  UNREAD_COUNT_CAP,
  type Attachment,
  type ChannelSummary,
  type DirectoryUser,
  type Guild,
  type GuildSummary,
  type Me,
  type Message,
  type PresenceEntry,
  type PresenceStatus,
  type ReadState,
  type ServerFrame,
  type User,
} from '@harmony/shared';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ConnectionStatus } from '../api/realtime.js';
import { compareIds, maxId } from '../lib/ids.js';
import {
  addReaction,
  applyDelete,
  mergeMessages,
  removeReaction,
  updateMessage,
} from './messages.js';

export interface ChannelHistory {
  messages: readonly Message[];
  hasMore: boolean;
  loaded: boolean;
}

export interface OutboxItem {
  nonce: string;
  channelId: string;
  content: string;
  replyToId: string | null;
  attachments: readonly Attachment[];
  createdAt: string;
  status: 'pending' | 'failed';
  error?: string;
}

export interface Snapshot {
  guilds: readonly GuildSummary[];
  channels: readonly ChannelSummary[];
  presence: readonly PresenceEntry[];
  users?: readonly User[];
}

/** Messages kept for a channel the user is no longer looking at. */
export const IDLE_HISTORY_LIMIT = 50;

export interface AppState {
  me: Me | null;
  connection: ConnectionStatus;
  users: Record<string, User>;
  guilds: Record<string, GuildSummary>;
  channels: Record<string, ChannelSummary>;
  guildMembers: Record<string, readonly string[]>;
  channelMembers: Record<string, readonly string[]>;
  /** Absent means offline. */
  presence: Record<string, PresenceStatus>;
  history: Record<string, ChannelHistory>;
  outbox: Record<string, readonly OutboxItem[]>;
  /** channel id -> user id -> expiry timestamp (ms) */
  typing: Record<string, Record<string, number>>;
  activeChannelId: string | null;
  /** The channel whose newest message is on screen, so new messages need no badge. */
  followingChannelId: string | null;
  /** Mention events already counted, so a redelivered event does not count twice. */
  countedMentions: Record<string, true>;

  setConnection(status: ConnectionStatus): void;
  loadSnapshot(snapshot: Snapshot, me?: Me): void;
  ingestUsers(users: readonly User[]): void;
  setMe(me: Me): void;
  setActiveChannel(channelId: string | null): void;
  setFollowing(channelId: string | null): void;
  openHistory(channelId: string): void;
  dropHistory(channelId: string): void;
  historyLoaded(channelId: string, messages: readonly Message[], hasMore: boolean): void;
  historyOlder(channelId: string, messages: readonly Message[], hasMore: boolean): void;
  upsertGuild(guild: GuildSummary | Guild): void;
  upsertChannel(channel: ChannelSummary): void;
  setGuildMembers(guildId: string, members: readonly DirectoryUser[]): void;
  setChannelMembers(channelId: string, members: readonly DirectoryUser[]): void;
  applyReadState(state: ReadState): void;
  queueOutbox(item: OutboxItem): void;
  failOutbox(nonce?: string, error?: string): void;
  removeOutbox(channelId: string, nonce: string): void;
  pruneTyping(now?: number): void;
  applyFrame(frame: ServerFrame, now?: number): void;
}

const cap = (value: number) => Math.min(UNREAD_COUNT_CAP, Math.max(0, value));

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

function byId<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

function mergeUsers(known: Record<string, User>, incoming: readonly User[]): Record<string, User> {
  let next = known;
  for (const user of incoming) {
    const current = known[user.id];
    if (
      !current ||
      current.displayName !== user.displayName ||
      current.avatarUrl !== user.avatarUrl
    ) {
      if (next === known) next = { ...known };
      next[user.id] = {
        id: user.id,
        login: user.login,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      };
    }
  }
  return next;
}

export function createAppStore(): StoreApi<AppState> {
  return createStore<AppState>()((set, get) => {
    /** Applies a message to the cached history and the unread state of its channel. */
    const receive = (message: Message, nonce: string | undefined): void => {
      set((state) => {
        const next: Partial<AppState> = {};
        const history = state.history[message.channelId];
        if (history) {
          next.history = {
            ...state.history,
            [message.channelId]: {
              ...history,
              messages: mergeMessages(history.messages, [message]),
            },
          };
        }
        const queue = state.outbox[message.channelId];
        if (nonce && queue?.some((item) => item.nonce === nonce)) {
          next.outbox = {
            ...state.outbox,
            [message.channelId]: queue.filter((item) => item.nonce !== nonce),
          };
        }
        next.users = mergeUsers(state.users, [message.author]);

        const typing = state.typing[message.channelId];
        if (typing?.[message.author.id] !== undefined) {
          next.typing = {
            ...state.typing,
            [message.channelId]: omit(typing, message.author.id),
          };
        }

        const channel = state.channels[message.channelId];
        if (channel) {
          const isNew =
            channel.lastMessageId === null || compareIds(message.id, channel.lastMessageId) > 0;
          const foreign = message.author.id !== state.me?.id && !message.deleted;
          const following = state.followingChannelId === message.channelId;
          const unread = isNew && foreign && !following;
          next.channels = {
            ...state.channels,
            [channel.id]: {
              ...channel,
              lastMessageId: maxId(channel.lastMessageId, message.id),
              unreadCount: unread ? cap(channel.unreadCount + 1) : channel.unreadCount,
            },
          };
        }
        return next;
      });
    };

    return {
      me: null,
      connection: 'connecting',
      users: {},
      guilds: {},
      channels: {},
      guildMembers: {},
      channelMembers: {},
      presence: {},
      history: {},
      outbox: {},
      typing: {},
      activeChannelId: null,
      followingChannelId: null,
      countedMentions: {},

      setConnection: (connection) => set({ connection }),

      loadSnapshot: (snapshot, me) =>
        set((state) => {
          const channels = byId(snapshot.channels);
          // Drop anything the server no longer lists, along with its cached messages.
          const history = Object.fromEntries(
            Object.entries(state.history).filter(([id]) => id in channels),
          );
          const users = mergeUsers(state.users, [
            ...(snapshot.users ?? []),
            ...snapshot.channels.flatMap((channel) => (channel.dmUser ? [channel.dmUser] : [])),
          ]);
          return {
            ...(me && { me }),
            guilds: byId(snapshot.guilds),
            channels,
            history,
            users,
            presence: Object.fromEntries(
              snapshot.presence.map((entry) => [entry.userId, entry.status]),
            ),
          };
        }),

      ingestUsers: (users) => set((state) => ({ users: mergeUsers(state.users, users) })),
      setMe: (me) => set((state) => ({ me, users: mergeUsers(state.users, [me]) })),

      setActiveChannel: (channelId) =>
        set((state) => {
          const previous = state.activeChannelId;
          if (previous === channelId) return state;
          const next: Partial<AppState> = { activeChannelId: channelId, followingChannelId: null };
          const old = previous ? state.history[previous] : undefined;
          if (previous && old && old.messages.length > IDLE_HISTORY_LIMIT) {
            next.history = {
              ...state.history,
              [previous]: {
                ...old,
                messages: old.messages.slice(-IDLE_HISTORY_LIMIT),
                hasMore: true,
              },
            };
          }
          return next;
        }),

      setFollowing: (channelId) =>
        set((state) =>
          state.followingChannelId === channelId ? state : { followingChannelId: channelId },
        ),

      openHistory: (channelId) =>
        set((state) =>
          state.history[channelId]
            ? state
            : {
                history: {
                  ...state.history,
                  [channelId]: { messages: [], hasMore: false, loaded: false },
                },
              },
        ),

      dropHistory: (channelId) => set((state) => ({ history: omit(state.history, channelId) })),

      historyLoaded: (channelId, messages, hasMore) =>
        set((state) => {
          const current = state.history[channelId];
          return {
            users: mergeUsers(
              state.users,
              messages.map((message) => message.author),
            ),
            history: {
              ...state.history,
              [channelId]: {
                messages: mergeMessages(current?.messages ?? [], messages),
                // A refresh of the newest page must not forget that older pages exist.
                hasMore: current?.loaded && !hasMore ? current.hasMore : hasMore,
                loaded: true,
              },
            },
          };
        }),

      historyOlder: (channelId, messages, hasMore) =>
        set((state) => {
          const current = state.history[channelId];
          if (!current) return state;
          return {
            users: mergeUsers(
              state.users,
              messages.map((message) => message.author),
            ),
            history: {
              ...state.history,
              [channelId]: {
                ...current,
                messages: mergeMessages(current.messages, messages),
                hasMore,
              },
            },
          };
        }),

      upsertGuild: (guild) =>
        set((state) => {
          const current = state.guilds[guild.id];
          const merged = { unreadCount: 0, mentionCount: 0, ...current, ...guild };
          return { guilds: { ...state.guilds, [guild.id]: merged } };
        }),

      upsertChannel: (channel) =>
        set((state) => ({
          channels: { ...state.channels, [channel.id]: channel },
          users: channel.dmUser ? mergeUsers(state.users, [channel.dmUser]) : state.users,
        })),

      setGuildMembers: (guildId, members) =>
        set((state) => ({
          guildMembers: { ...state.guildMembers, [guildId]: members.map((member) => member.id) },
          users: mergeUsers(state.users, members),
        })),

      setChannelMembers: (channelId, members) =>
        set((state) => ({
          channelMembers: {
            ...state.channelMembers,
            [channelId]: members.map((member) => member.id),
          },
          users: mergeUsers(state.users, members),
        })),

      applyReadState: (read) =>
        set((state) => {
          const channel = state.channels[read.channelId];
          if (!channel) return state;
          return {
            channels: {
              ...state.channels,
              [channel.id]: {
                ...channel,
                lastReadMessageId: maxId(channel.lastReadMessageId, read.lastReadMessageId),
                unreadCount: read.unreadCount,
                mentionCount: read.mentionCount,
              },
            },
          };
        }),

      queueOutbox: (item) =>
        set((state) => ({
          outbox: {
            ...state.outbox,
            [item.channelId]: [...(state.outbox[item.channelId] ?? []), item],
          },
        })),

      failOutbox: (nonce, error) =>
        set((state) => ({
          outbox: Object.fromEntries(
            Object.entries(state.outbox).map(([channelId, items]) => [
              channelId,
              items.map((item): OutboxItem =>
                item.status === 'pending' && (nonce === undefined || item.nonce === nonce)
                  ? { ...item, status: 'failed', ...(error && { error }) }
                  : item,
              ),
            ]),
          ),
        })),

      removeOutbox: (channelId, nonce) =>
        set((state) => ({
          outbox: {
            ...state.outbox,
            [channelId]: (state.outbox[channelId] ?? []).filter((item) => item.nonce !== nonce),
          },
        })),

      pruneTyping: (now = Date.now()) =>
        set((state) => {
          let changed = false;
          const typing: AppState['typing'] = {};
          for (const [channelId, users] of Object.entries(state.typing)) {
            const live = Object.fromEntries(
              Object.entries(users).filter(([, until]) => until > now),
            );
            if (Object.keys(live).length !== Object.keys(users).length) changed = true;
            if (Object.keys(live).length > 0) typing[channelId] = live;
            else if (Object.keys(users).length > 0) changed = true;
          }
          return changed ? { typing } : state;
        }),

      applyFrame: (frame, now = Date.now()) => {
        switch (frame.type) {
          case 'hello':
            get().setMe(frame.user);
            break;
          case 'ack':
            receive(frame.message, frame.nonce);
            break;
          case 'message.created':
            receive(frame.message, frame.nonce);
            break;
          case 'message.updated':
            set((state) => {
              const history = state.history[frame.message.channelId];
              return {
                users: mergeUsers(state.users, [frame.message.author]),
                ...(history && {
                  history: {
                    ...state.history,
                    [frame.message.channelId]: {
                      ...history,
                      messages: mergeMessages(history.messages, [frame.message]),
                    },
                  },
                }),
              };
            });
            break;
          case 'message.deleted':
            set((state) => {
              const history = state.history[frame.channelId];
              if (!history) return state;
              return {
                history: {
                  ...state.history,
                  [frame.channelId]: {
                    ...history,
                    messages: applyDelete(history.messages, frame.messageId),
                  },
                },
              };
            });
            break;
          case 'reaction.added':
          case 'reaction.removed':
            set((state) => {
              const history = state.history[frame.channelId];
              if (!history) return state;
              const change = frame.type === 'reaction.added' ? addReaction : removeReaction;
              const messages = updateMessage(history.messages, frame.messageId, (message) =>
                change(message, frame.emoji, frame.userId),
              );
              if (messages === history.messages) return state;
              return { history: { ...state.history, [frame.channelId]: { ...history, messages } } };
            });
            break;
          case 'typing':
            if (frame.userId === get().me?.id) break;
            set((state) => ({
              typing: {
                ...state.typing,
                [frame.channelId]: {
                  ...state.typing[frame.channelId],
                  [frame.userId]: now + TYPING_EXPIRY_MS,
                },
              },
            }));
            break;
          case 'presence.updated':
            set((state) => ({
              presence:
                frame.status === 'offline'
                  ? omit(state.presence, frame.userId)
                  : { ...state.presence, [frame.userId]: frame.status },
            }));
            break;
          case 'read.updated':
            get().applyReadState(frame);
            break;
          case 'mention':
            set((state) => {
              const channel = state.channels[frame.channelId];
              const key = `${frame.channelId}:${frame.messageId}`;
              if (!channel || state.countedMentions[key]) return state;
              if (
                channel.lastReadMessageId &&
                compareIds(frame.messageId, channel.lastReadMessageId) <= 0
              ) {
                return state;
              }
              if (state.followingChannelId === frame.channelId) return state;
              return {
                countedMentions: { ...state.countedMentions, [key]: true },
                channels: {
                  ...state.channels,
                  [channel.id]: { ...channel, mentionCount: cap(channel.mentionCount + 1) },
                },
              };
            });
            break;
          case 'channel.joined':
            get().upsertChannel(frame.channel);
            break;
          case 'channel.updated':
            set((state) => {
              const current = state.channels[frame.channel.id];
              if (!current) return state;
              return {
                channels: { ...state.channels, [current.id]: { ...current, ...frame.channel } },
              };
            });
            break;
          case 'channel.removed':
            set((state) => ({
              channels: omit(state.channels, frame.channelId),
              history: omit(state.history, frame.channelId),
              outbox: omit(state.outbox, frame.channelId),
              typing: omit(state.typing, frame.channelId),
            }));
            break;
          case 'guild.joined':
            get().upsertGuild(frame.guild);
            break;
          case 'guild.updated':
            set((state) => {
              const current = state.guilds[frame.guild.id];
              return current
                ? { guilds: { ...state.guilds, [current.id]: { ...current, ...frame.guild } } }
                : state;
            });
            break;
          case 'guild.removed':
            set((state) => {
              const gone = Object.values(state.channels)
                .filter((channel) => channel.guildId === frame.guildId)
                .map((channel) => channel.id);
              const drop = <T>(record: Record<string, T>) =>
                Object.fromEntries(Object.entries(record).filter(([id]) => !gone.includes(id)));
              return {
                guilds: omit(state.guilds, frame.guildId),
                guildMembers: omit(state.guildMembers, frame.guildId),
                channels: drop(state.channels),
                history: drop(state.history),
                outbox: drop(state.outbox),
                typing: drop(state.typing),
              };
            });
            break;
          case 'guild.member_joined':
            set((state) => {
              const guild = state.guilds[frame.guildId];
              const members = state.guildMembers[frame.guildId];
              const already = members?.includes(frame.user.id) ?? false;
              return {
                users: mergeUsers(state.users, [frame.user]),
                ...(guild &&
                  !already && {
                    guilds: {
                      ...state.guilds,
                      [guild.id]: { ...guild, memberCount: guild.memberCount + 1 },
                    },
                  }),
                ...(members &&
                  !already && {
                    guildMembers: {
                      ...state.guildMembers,
                      [frame.guildId]: [...members, frame.user.id],
                    },
                  }),
              };
            });
            break;
          case 'guild.member_left':
            set((state) => {
              const guild = state.guilds[frame.guildId];
              const members = state.guildMembers[frame.guildId];
              return {
                ...(guild && {
                  guilds: {
                    ...state.guilds,
                    [guild.id]: { ...guild, memberCount: Math.max(0, guild.memberCount - 1) },
                  },
                }),
                ...(members && {
                  guildMembers: {
                    ...state.guildMembers,
                    [frame.guildId]: members.filter((id) => id !== frame.userId),
                  },
                }),
              };
            });
            break;
          case 'backfill': {
            const { channelId, messages, hasMore } = frame;
            if (hasMore) {
              // Too many missed to splice in: forget the cache so the view reloads the newest page.
              get().dropHistory(channelId);
              if (get().activeChannelId === channelId) get().openHistory(channelId);
            } else {
              for (const message of messages) receive(message, undefined);
            }
            break;
          }
          case 'error':
            if (frame.nonce) get().failOutbox(frame.nonce, frame.message);
            break;
        }
      },
    };
  });
}

export const appStore = createAppStore();

export function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(appStore, selector);
}
