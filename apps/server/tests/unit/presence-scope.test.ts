import { describe, expect, it } from 'vitest';
import { presenceDmTopic, presenceGuildTopic } from '@harmony/shared';
import { effectiveStatus, presenceTopicsOf, topicChangeFor } from '../../src/presence/scope.js';

describe('presence scope', () => {
  it('maps memberships to one topic per guild and per DM', () => {
    expect(
      presenceTopicsOf({
        guildIds: ['1', '2'],
        dms: [{ channelId: '9', peerId: '5' }],
      }),
    ).toEqual(['harmony:presence:guild:1', 'harmony:presence:guild:2', 'harmony:presence:dm:9']);
    expect(presenceTopicsOf({ guildIds: [], dms: [] })).toEqual([]);
  });

  it('two users in the same DM or guild get the same topic, so visibility is symmetric', () => {
    expect(presenceDmTopic('9')).toBe(presenceDmTopic('9'));
    expect(presenceGuildTopic('1')).not.toBe(presenceDmTopic('1'));
  });

  it('turns membership events into topic joins and leaves', () => {
    expect(topicChangeFor({ type: 'guild.joined', guild: { id: '3' } })).toEqual({
      join: ['harmony:presence:guild:3'],
      leave: [],
    });
    expect(topicChangeFor({ type: 'guild.removed', guildId: '3' })).toEqual({
      join: [],
      leave: ['harmony:presence:guild:3'],
    });
    expect(topicChangeFor({ type: 'channel.joined', channel: { id: '8', kind: 'dm' } })).toEqual({
      join: ['harmony:presence:dm:8'],
      leave: [],
    });
    expect(topicChangeFor({ type: 'channel.removed', channelId: '8' })).toEqual({
      join: [],
      leave: ['harmony:presence:dm:8'],
    });
  });

  it('ignores events that do not change who can see whom', () => {
    expect(
      topicChangeFor({ type: 'channel.joined', channel: { id: '8', kind: 'text' } }),
    ).toBeNull();
    expect(topicChangeFor({ type: 'mention', channelId: '1' })).toBeNull();
    expect(topicChangeFor({ type: 'guild.member_joined', guildId: '1' })).toBeNull();
  });

  it('shows invisible as offline', () => {
    expect(effectiveStatus('invisible')).toBe('offline');
    expect(effectiveStatus('dnd')).toBe('dnd');
  });
});
