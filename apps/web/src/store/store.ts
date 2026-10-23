import {
  TYPING_EXPIRY_MS,
  UNREAD_COUNT_CAP,
  type Attachment,
  type ChannelOverwrite,
  type ChannelSummary,
  type DirectoryUser,
  type EffectivePermissions,
  type Guild,
  type GuildModule,
  type GuildSummary,
  type Me,
  type Message,
  type PresenceEntry,
  type PresenceStatus,
  type ReadState,
  type Role,
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
import {
  addInteraction,
  clearPendingFrom,
  pruneExpired,
  type LocalInteraction,
} from './interactions.js';

export interface ChannelHistory {
  messages: readonly Message[];
  hasMore: boolean;
  loaded: boolean;
}

/** What a guild knows about one of its members besides who they are. */
export interface MemberInfo {
  roleIds: readonly string[];
  nickname: string | null;
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
  /** Left out on a reconnect: the presence refresh after `hello` is the authority there. */
  presence?: readonly PresenceEntry[];
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
  /** Each guild's modules and their state; absent until the guild has been opened. */
  guildModules: Record<string, readonly GuildModule[]>;
  channelMembers: Record<string, readonly string[]>;
  /** Roles of each guild, highest first; absent until a guild's roles were needed. */
  roles: Record<string, readonly Role[]>;
  memberInfo: Record<string, Record<string, MemberInfo>>;
  /** What the signed-in user may do in a guild, and in the channels asked about. */
  guildPermissions: Record<string, EffectivePermissions>;
  channelPermissions: Record<string, EffectivePermissions>;
  overwrites: Record<string, readonly ChannelOverwrite[]>;
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
  /** Slash command placeholders, errors and ephemeral replies per channel; never sent to the server. */
  interactions: Record<string, readonly LocalInteraction[]>;
  interactionSeq: number;

  setConnection(status: ConnectionStatus): void;
  loadSnapshot(snapshot: Snapshot, me?: Me): void;
  /**
   * A presence fetch is in flight: live `presence.batch` updates that arrive until
   * `finishPresenceRefresh` win over the fetched snapshot, which may be older than they are.
   */
  beginPresenceRefresh(): number;
  /** Replaces the presence map with the snapshot (null if the fetch failed), keeping newer live updates. */
  finishPresenceRefresh(entries: readonly PresenceEntry[] | null): void;
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
  setGuildMembers(guildId: string, members: readonly (DirectoryUser & Partial<MemberInfo>)[]): void;
  setRoles(guildId: string, roles: readonly Role[]): void;
  setPermissions(guildId: string, permissions: EffectivePermissions, channelId?: string): void;
  setOverwrites(channelId: string, overwrites: readonly ChannelOverwrite[]): void;
  setGuildModules(guildId: string, modules: readonly GuildModule[]): void;
  /** Changes one cached message; modules use it to apply their own frames. */
  patchMessage(channelId: string, messageId: string, update: (message: Message) => Message): void;
  setChannelMembers(channelId: string, members: readonly DirectoryUser[]): void;
  applyReadState(state: ReadState): void;
  queueOutbox(item: OutboxItem): void;
  failOutbox(nonce?: string, error?: string): void;
  removeOutbox(channelId: string, nonce: string): void;
  pruneTyping(now?: number): void;
  dismissInteraction(channelId: string, key: string): void;
  pruneInteractions(now?: number): void;
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
      current.avatarUrl !== user.avatarUrl ||
      current.isBot !== user.isBot
    ) {
      if (next === known) next = { ...known };
      next[user.id] = {
        id: user.id,
        login: user.login,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        ...(user.isBot && { isBot: true }),
      };
    }
  }
  return next;
}

export function createAppStore(): StoreApi<AppState> {
  return createStore<AppState>()((set, get) => {
    // Bookkeeping for presence fetches that overlap live updates; only used while one is in flight.
    let liveSeq = 0;
    let refreshesInFlight = 0;
    const refreshStarts: number[] = [];
    const liveMarks = new Map<string, number>();

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

        const interactions = state.interactions[message.channelId];
        if (interactions) {
          const cleared = clearPendingFrom(interactions, message.author.id);
          if (cleared !== interactions) {
            next.interactions = { ...state.interactions, [message.channelId]: cleared };
          }
        }

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
      roles: {},
      memberInfo: {},
      guildPermissions: {},
      channelPermissions: {},
      overwrites: {},
      guildModules: {},
      channelMembers: {},
      presence: {},
      history: {},
      outbox: {},
      typing: {},
      activeChannelId: null,
      followingChannelId: null,
      countedMentions: {},
      interactions: {},
      interactionSeq: 0,

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
            ...(snapshot.presence && {
              presence: Object.fromEntries(
                snapshot.presence.map((entry) => [entry.userId, entry.status]),
              ),
            }),
          };
        }),

      beginPresenceRefresh: () => {
        refreshesInFlight++;
        refreshStarts.push(liveSeq);
        return liveSeq;
      },

      finishPresenceRefresh: (entries) => {
        const since = refreshStarts.shift() ?? liveSeq;
        refreshesInFlight = Math.max(0, refreshesInFlight - 1);
        if (entries) {
          set((state) => {
            const next: Record<string, PresenceStatus> = {};
            for (const entry of entries) next[entry.userId] = entry.status;
            for (const [userId, seq] of liveMarks) {
              if (seq <= since) continue;
              const live = state.presence[userId];
              if (live) next[userId] = live;
              else delete next[userId];
            }
            return { presence: next };
          });
        }
        if (refreshesInFlight === 0) liveMarks.clear();
      },

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
          memberInfo: {
            ...state.memberInfo,
            [guildId]: Object.fromEntries(
              members.map((member) => [
                member.id,
                { roleIds: member.roleIds ?? [], nickname: member.nickname ?? null },
              ]),
            ),
          },
          users: mergeUsers(state.users, members),
        })),

      setRoles: (guildId, roles) =>
        set((state) => ({
          roles: { ...state.roles, [guildId]: [...roles].sort((a, b) => b.position - a.position) },
        })),

      setPermissions: (guildId, permissions, channelId) =>
        set((state) =>
          channelId
            ? { channelPermissions: { ...state.channelPermissions, [channelId]: permissions } }
            : { guildPermissions: { ...state.guildPermissions, [guildId]: permissions } },
        ),

      setOverwrites: (channelId, overwrites) =>
        set((state) => ({ overwrites: { ...state.overwrites, [channelId]: overwrites } })),

      setGuildModules: (guildId, modules) =>
        set((state) => ({ guildModules: { ...state.guildModules, [guildId]: modules } })),

      patchMessage: (channelId, messageId, update) =>
        set((state) => {
          const history = state.history[channelId];
          if (!history) return state;
          const messages = updateMessage(history.messages, messageId, update);
          if (messages === history.messages) return state;
          return { history: { ...state.history, [channelId]: { ...history, messages } } };
        }),

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

      dismissInteraction: (channelId, key) =>
        set((state) => ({
          interactions: {
            ...state.interactions,
            [channelId]: (state.interactions[channelId] ?? []).filter((item) => item.key !== key),
          },
        })),

      pruneInteractions: (now = Date.now()) =>
        set((state) => {
          let changed = false;
          const interactions = Object.fromEntries(
            Object.entries(state.interactions).map(([channelId, list]) => {
              const live = pruneExpired(list, now);
              if (live !== list) changed = true;
              return [channelId, live];
            }),
          );
          return changed ? { interactions } : state;
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
          case 'presence.batch':
            set((state) => {
              const presence = { ...state.presence };
              // Updates are in order; the last one for a user wins.
              for (const update of frame.updates) {
                if (refreshesInFlight > 0) liveMarks.set(update.userId, ++liveSeq);
                if (update.status === 'offline') delete presence[update.userId];
                else presence[update.userId] = update.status;
              }
              return { presence };
            });
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
              interactions: omit(state.interactions, frame.channelId),
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
          case 'guild.role_created':
          case 'guild.role_updated':
            set((state) => {
              const known = state.roles[frame.guildId];
              if (!known) return state;
              const others = known.filter((role) => role.id !== frame.role.id);
              return {
                roles: {
                  ...state.roles,
                  [frame.guildId]: [...others, frame.role].sort((a, b) => b.position - a.position),
                },
              };
            });
            break;
          case 'guild.role_deleted':
            set((state) => {
              const info = state.memberInfo[frame.guildId];
              return {
                roles: {
                  ...state.roles,
                  [frame.guildId]: (state.roles[frame.guildId] ?? []).filter(
                    (role) => role.id !== frame.roleId,
                  ),
                },
                ...(info && {
                  memberInfo: {
                    ...state.memberInfo,
                    [frame.guildId]: Object.fromEntries(
                      Object.entries(info).map(([id, entry]) => [
                        id,
                        { ...entry, roleIds: entry.roleIds.filter((r) => r !== frame.roleId) },
                      ]),
                    ),
                  },
                }),
              };
            });
            break;
          case 'guild.member_updated':
            set((state) => ({
              memberInfo: {
                ...state.memberInfo,
                [frame.guildId]: {
                  ...state.memberInfo[frame.guildId],
                  [frame.userId]: { roleIds: frame.roleIds, nickname: frame.nickname },
                },
              },
            }));
            break;
          case 'channel.overwrites_updated':
            set((state) => ({
              overwrites: { ...state.overwrites, [frame.channelId]: frame.overwrites },
            }));
            break;
          case 'guild.modules_updated':
            set((state) => {
              const list = state.guildModules[frame.guildId];
              if (!list) return state;
              return {
                guildModules: {
                  ...state.guildModules,
                  [frame.guildId]: list.map((module) =>
                    module.id === frame.moduleId
                      ? { ...module, enabled: frame.enabled, settings: frame.settings }
                      : module,
                  ),
                },
              };
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
                roles: omit(state.roles, frame.guildId),
                memberInfo: omit(state.memberInfo, frame.guildId),
                guildPermissions: omit(state.guildPermissions, frame.guildId),
                guildModules: omit(state.guildModules, frame.guildId),
                channels: drop(state.channels),
                history: drop(state.history),
                outbox: drop(state.outbox),
                typing: drop(state.typing),
                interactions: drop(state.interactions),
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
          case 'interaction.pending':
          case 'interaction.ephemeral':
          case 'interaction.failed':
            set((state) => {
              const key = `${frame.interactionId}:${String(state.interactionSeq)}`;
              const base = {
                key,
                interactionId: frame.interactionId,
                botId: frame.botId,
                ...(frame.source && { source: frame.source }),
                command: frame.command,
              };
              const item: LocalInteraction =
                frame.type === 'interaction.pending'
                  ? { ...base, kind: 'pending', expiresAt: frame.expiresAt }
                  : frame.type === 'interaction.ephemeral'
                    ? {
                        ...base,
                        kind: 'ephemeral',
                        content: frame.content,
                        embeds: frame.embeds ?? [],
                      }
                    : { ...base, kind: 'failed', reason: frame.reason };
              return {
                interactionSeq: state.interactionSeq + 1,
                interactions: {
                  ...state.interactions,
                  [frame.channelId]: addInteraction(state.interactions[frame.channelId], item),
                },
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
