import { TYPING_EXPIRY_MS } from '@harmony/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { channel, me, message, user } from '../test/factories.js';
import { createAppStore, type OutboxItem } from './store.js';

let store: ReturnType<typeof createAppStore>;
const state = () => store.getState();
const history = (id = '10') => state().history[id]?.messages ?? [];

beforeEach(() => {
  store = createAppStore();
  state().loadSnapshot(
    {
      guilds: [],
      channels: [
        channel('10', { lastMessageId: '100', lastReadMessageId: '100' }),
        channel('11', { lastMessageId: '50', lastReadMessageId: '50' }),
      ],
      presence: [],
    },
    me,
  );
  state().openHistory('10');
  state().historyLoaded('10', [message('99'), message('100')], false);
});

const outboxItem = (nonce: string, extra: Partial<OutboxItem> = {}): OutboxItem => ({
  nonce,
  channelId: '10',
  content: 'hello',
  replyToId: null,
  attachments: [],
  createdAt: '2026-10-22T09:00:00.000Z',
  status: 'pending',
  ...extra,
});

describe('messages', () => {
  it('adds created messages in id order and dedupes live + backfill copies', () => {
    state().applyFrame({ type: 'message.created', message: message('102') });
    state().applyFrame({ type: 'message.created', message: message('101') });
    state().applyFrame({
      type: 'backfill',
      channelId: '10',
      messages: [message('101')],
      hasMore: false,
    });
    expect(history().map((m) => m.id)).toEqual(['99', '100', '101', '102']);
  });

  it('keeps messages for channels that were never opened out of the cache but updates the summary', () => {
    state().applyFrame({ type: 'message.created', message: message('60', { channelId: '11' }) });
    expect(state().history['11']).toBeUndefined();
    expect(state().channels['11']).toMatchObject({ lastMessageId: '60', unreadCount: 1 });
  });

  it('replaces a message on update and shows the edit', () => {
    state().applyFrame({
      type: 'message.updated',
      message: message('100', { content: 'edited', editedAt: '2026-10-22T09:05:00.000Z' }),
    });
    expect(history().at(-1)).toMatchObject({
      content: 'edited',
      editedAt: '2026-10-22T09:05:00.000Z',
    });
  });

  it('turns deleted messages into tombstones and marks replies to them', () => {
    state().applyFrame({
      type: 'message.created',
      message: message('101', {
        replyTo: { id: '100', authorId: '2', contentPreview: 'message 100', deleted: false },
      }),
    });
    state().applyFrame({ type: 'message.deleted', channelId: '10', messageId: '100' });
    const [, deleted, reply] = history();
    expect(deleted).toMatchObject({ deleted: true, content: '', reactions: [], attachments: [] });
    expect(reply?.replyTo).toMatchObject({ deleted: true, contentPreview: '' });
  });
});

describe('reactions', () => {
  it('adds, counts and removes reactions idempotently', () => {
    const add = (userId: string) =>
      state().applyFrame({
        type: 'reaction.added',
        channelId: '10',
        messageId: '100',
        emoji: '👍',
        userId,
      });
    const remove = (userId: string) =>
      state().applyFrame({
        type: 'reaction.removed',
        channelId: '10',
        messageId: '100',
        emoji: '👍',
        userId,
      });

    add('2');
    add('3');
    add('3');
    expect(history().at(-1)?.reactions).toEqual([{ emoji: '👍', count: 2, userIds: ['2', '3'] }]);
    remove('2');
    expect(history().at(-1)?.reactions).toEqual([{ emoji: '👍', count: 1, userIds: ['3'] }]);
    remove('3');
    expect(history().at(-1)?.reactions).toEqual([]);
    remove('3');
    expect(history().at(-1)?.reactions).toEqual([]);
  });
});

describe('read state and unread counts', () => {
  it('counts other people messages as unread, not my own', () => {
    state().applyFrame({ type: 'message.created', message: message('101') });
    state().applyFrame({
      type: 'message.created',
      message: message('102', { author: user('1', 'Ada') }),
    });
    expect(state().channels['10']?.unreadCount).toBe(1);
  });

  it('does not double count a message delivered live and in a backfill', () => {
    state().applyFrame({ type: 'message.created', message: message('101') });
    state().applyFrame({
      type: 'backfill',
      channelId: '10',
      messages: [message('101')],
      hasMore: false,
    });
    expect(state().channels['10']?.unreadCount).toBe(1);
  });

  it('does not badge the channel that is being followed', () => {
    state().setFollowing('10');
    state().applyFrame({ type: 'message.created', message: message('101') });
    expect(state().channels['10']?.unreadCount).toBe(0);
  });

  it('caps at 100', () => {
    for (let id = 101; id < 230; id++) {
      state().applyFrame({ type: 'message.created', message: message(String(id)) });
    }
    expect(state().channels['10']?.unreadCount).toBe(100);
  });

  it('applies read.updated and never moves the marker back', () => {
    state().applyFrame({ type: 'message.created', message: message('101') });
    state().applyFrame({
      type: 'read.updated',
      channelId: '10',
      lastReadMessageId: '101',
      unreadCount: 0,
      mentionCount: 0,
    });
    expect(state().channels['10']).toMatchObject({ lastReadMessageId: '101', unreadCount: 0 });
    state().applyFrame({
      type: 'read.updated',
      channelId: '10',
      lastReadMessageId: '90',
      unreadCount: 2,
      mentionCount: 0,
    });
    expect(state().channels['10']?.lastReadMessageId).toBe('101');
  });

  it('counts a mention once, and ignores it once read', () => {
    state().applyFrame({ type: 'mention', channelId: '11', messageId: '60' });
    state().applyFrame({ type: 'mention', channelId: '11', messageId: '60' });
    expect(state().channels['11']?.mentionCount).toBe(1);
    state().applyFrame({ type: 'mention', channelId: '11', messageId: '40' });
    expect(state().channels['11']?.mentionCount).toBe(1);
  });
});

describe('presence', () => {
  it('tracks online users and removes offline ones', () => {
    state().applyFrame({ type: 'presence.updated', userId: '2', status: 'online' });
    state().applyFrame({ type: 'presence.updated', userId: '3', status: 'dnd' });
    expect(state().presence).toEqual({ '2': 'online', '3': 'dnd' });
    state().applyFrame({ type: 'presence.updated', userId: '2', status: 'offline' });
    expect(state().presence).toEqual({ '3': 'dnd' });
  });
});

describe('typing', () => {
  it('expires after the protocol timeout', () => {
    state().applyFrame({ type: 'typing', channelId: '10', userId: '2' }, 1000);
    expect(state().typing['10']).toEqual({ '2': 1000 + TYPING_EXPIRY_MS });
    state().pruneTyping(1000 + TYPING_EXPIRY_MS - 1);
    expect(Object.keys(state().typing['10'] ?? {})).toEqual(['2']);
    state().pruneTyping(1000 + TYPING_EXPIRY_MS);
    expect(state().typing['10']).toBeUndefined();
  });

  it('ignores my own pings and clears when the person sends', () => {
    state().applyFrame({ type: 'typing', channelId: '10', userId: '1' });
    expect(state().typing['10']).toBeUndefined();
    state().applyFrame({ type: 'typing', channelId: '10', userId: '2' });
    state().applyFrame({ type: 'message.created', message: message('101') });
    expect(state().typing['10']).toEqual({});
  });
});

describe('outbox', () => {
  it('is reconciled by nonce when the broadcast arrives', () => {
    state().queueOutbox(outboxItem('n1'));
    state().queueOutbox(outboxItem('n2'));
    state().applyFrame({
      type: 'message.created',
      message: message('101', { author: user('1', 'Ada') }),
      nonce: 'n1',
    });
    expect(state().outbox['10']?.map((i) => i.nonce)).toEqual(['n2']);
    expect(history().map((m) => m.id)).toContain('101');
  });

  it('is reconciled by ack, and ack plus broadcast produce one message', () => {
    state().queueOutbox(outboxItem('n1'));
    const sent = message('101', { author: user('1', 'Ada') });
    state().applyFrame({ type: 'ack', nonce: 'n1', message: sent });
    state().applyFrame({ type: 'message.created', message: sent, nonce: 'n1' });
    expect(state().outbox['10']).toEqual([]);
    expect(history().filter((m) => m.id === '101')).toHaveLength(1);
  });

  it('marks only the failed nonce when the server rejects a send', () => {
    state().queueOutbox(outboxItem('n1'));
    state().queueOutbox(outboxItem('n2'));
    state().applyFrame({ type: 'error', code: 'rate_limited', message: 'slow down', nonce: 'n2' });
    expect(state().outbox['10']?.map((i) => [i.nonce, i.status])).toEqual([
      ['n1', 'pending'],
      ['n2', 'failed'],
    ]);
  });

  it('fails every pending item when the connection drops', () => {
    state().queueOutbox(outboxItem('n1'));
    state().failOutbox(undefined, 'Not connected');
    expect(state().outbox['10']?.[0]).toMatchObject({ status: 'failed', error: 'Not connected' });
  });

  it('a late broadcast still clears a failed item', () => {
    state().queueOutbox(outboxItem('n1'));
    state().failOutbox();
    state().applyFrame({ type: 'message.created', message: message('101'), nonce: 'n1' });
    expect(state().outbox['10']).toEqual([]);
  });
});

describe('channels and guilds', () => {
  it('drops cache and outbox when a channel is removed', () => {
    state().queueOutbox(outboxItem('n1'));
    state().applyFrame({ type: 'channel.removed', channelId: '10' });
    expect(state().channels['10']).toBeUndefined();
    expect(state().history['10']).toBeUndefined();
    expect(state().outbox['10']).toBeUndefined();
  });

  it('removes a guild together with its channels', () => {
    state().applyFrame({
      type: 'guild.joined',
      guild: {
        id: '5',
        name: 'Club',
        iconUrl: null,
        ownerId: '2',
        memberCount: 2,
        unreadCount: 0,
        mentionCount: 0,
      },
    });
    state().applyFrame({ type: 'guild.removed', guildId: '5' });
    expect(state().guilds['5']).toBeUndefined();
    expect(Object.keys(state().channels)).toEqual([]);
  });

  it('a backfill that says there is more drops the cache so the view reloads', () => {
    state().setActiveChannel('10');
    state().applyFrame({ type: 'backfill', channelId: '10', messages: [], hasMore: true });
    expect(state().history['10']).toEqual({ messages: [], hasMore: false, loaded: false });
  });

  it('trims the history of a channel you leave', () => {
    state().setActiveChannel('10');
    state().historyLoaded(
      '10',
      Array.from({ length: 120 }, (_, i) => message(String(200 + i))),
      true,
    );
    state().setActiveChannel('11');
    expect(state().history['10']?.messages).toHaveLength(50);
    expect(state().history['10']?.hasMore).toBe(true);
  });
});

describe('slash command interactions', () => {
  const pending = (id: string, extra: Record<string, unknown> = {}) =>
    ({
      type: 'interaction.pending',
      interactionId: id,
      channelId: '10',
      command: 'roll',
      botId: '9',
      expiresAt: '2026-10-22T09:15:00.000Z',
      ...extra,
    }) as const;
  const list = (channelId = '10') => state().interactions[channelId] ?? [];

  it('shows a placeholder while a deferred command runs and does not duplicate it', () => {
    state().applyFrame(pending('5'));
    state().applyFrame(pending('5'));
    expect(list()).toHaveLength(1);
    expect(list()[0]).toMatchObject({
      kind: 'pending',
      interactionId: '5',
      botId: '9',
      command: 'roll',
    });
  });

  it('replaces the placeholder with an ephemeral reply that stays local', () => {
    state().applyFrame(pending('5'));
    state().applyFrame({
      type: 'interaction.ephemeral',
      interactionId: '5',
      channelId: '10',
      command: 'roll',
      botId: '9',
      content: 'only you',
    });
    expect(list()).toMatchObject([{ kind: 'ephemeral', content: 'only you', embeds: [] }]);
    expect(history().some((m) => m.content === 'only you')).toBe(false);
  });

  it('keeps several ephemeral replies of one interaction as separate entries', () => {
    const reply = (content: string) =>
      ({
        type: 'interaction.ephemeral',
        interactionId: '5',
        channelId: '10',
        command: 'roll',
        botId: '9',
        content,
      }) as const;
    state().applyFrame(reply('first'));
    state().applyFrame(reply('second'));
    const keys = list().map((item) => item.key);
    expect(new Set(keys).size).toBe(2);
    const [first] = keys;
    if (first) state().dismissInteraction('10', first);
    expect(list()).toMatchObject([{ content: 'second' }]);
  });

  it('turns a placeholder into an inline failure', () => {
    state().applyFrame(pending('5'));
    state().applyFrame({
      type: 'interaction.failed',
      interactionId: '5',
      channelId: '10',
      command: 'roll',
      botId: '9',
      reason: 'timeout',
    });
    expect(list()).toMatchObject([{ kind: 'failed', reason: 'timeout' }]);
  });

  it('clears the placeholder when the bot posts in the channel', () => {
    state().applyFrame(pending('5'));
    state().applyFrame(pending('6', { botId: '12' }));
    state().applyFrame({
      type: 'message.created',
      message: message('101', { author: { ...user('9', 'Roller'), isBot: true } }),
    });
    expect(list()).toMatchObject([{ interactionId: '6' }]);
  });

  it('drops placeholders at their expiry time but keeps replies', () => {
    state().applyFrame(pending('5'));
    state().applyFrame({
      type: 'interaction.ephemeral',
      interactionId: '7',
      channelId: '10',
      command: 'echo',
      botId: '9',
      content: 'kept',
    });
    state().pruneInteractions(Date.parse('2026-10-22T09:14:59.000Z'));
    expect(list()).toHaveLength(2);
    state().pruneInteractions(Date.parse('2026-10-22T09:15:01.000Z'));
    expect(list()).toMatchObject([{ kind: 'ephemeral' }]);
  });

  it('forgets interactions with the channel', () => {
    state().applyFrame(pending('5'));
    state().applyFrame({ type: 'channel.removed', channelId: '10' });
    expect(state().interactions['10']).toBeUndefined();
  });

  it('remembers that a user is a bot', () => {
    state().applyFrame({
      type: 'message.created',
      message: message('102', { author: { ...user('9', 'Roller'), isBot: true } }),
    });
    expect(state().users['9']?.isBot).toBe(true);
  });
});

describe('modules', () => {
  const entry = (id: string, enabled: boolean) => ({
    id,
    name: id,
    description: '',
    optional: true,
    enabled,
    dependsOn: [],
    settings: {},
    settingsSchema: null,
    permissions: [],
  });

  it('updates a loaded guild’s module from guild.modules_updated, and ignores unloaded guilds', () => {
    state().setGuildModules('5', [entry('pins', true), entry('polls', true)]);
    state().applyFrame({
      type: 'guild.modules_updated',
      guildId: '5',
      moduleId: 'pins',
      enabled: false,
      settings: { a: 1 },
    });
    expect(state().guildModules['5']?.map((m) => [m.id, m.enabled])).toEqual([
      ['pins', false],
      ['polls', true],
    ]);
    state().applyFrame({
      type: 'guild.modules_updated',
      guildId: '6',
      moduleId: 'pins',
      enabled: false,
      settings: {},
    });
    expect(state().guildModules['6']).toBeUndefined();
  });

  it('patches one cached message', () => {
    state().patchMessage('10', '99', (m) => ({ ...m, modules: { polls: { x: 1 } } }));
    expect(history().find((m) => m.id === '99')?.modules).toEqual({ polls: { x: 1 } });
    expect(history().find((m) => m.id === '100')?.modules).toBeUndefined();
  });

  it('drops module data when a message is deleted', () => {
    state().patchMessage('10', '99', (m) => ({ ...m, modules: { polls: {} } }));
    state().applyFrame({ type: 'message.deleted', channelId: '10', messageId: '99' });
    expect(history().find((m) => m.id === '99')?.modules).toBeUndefined();
  });
});
