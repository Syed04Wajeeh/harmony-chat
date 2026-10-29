import { UNREAD_COUNT_CAP, type ChannelSummary, type GuildSummary } from '@harmony/shared';
import { compareIds } from '../lib/ids.js';

const cap = (value: number) => Math.min(UNREAD_COUNT_CAP, value);

/** Direct messages notify like mentions: every unread DM counts. */
export const badgeCount = (channel: ChannelSummary): number =>
  channel.kind === 'dm' ? channel.unreadCount : channel.mentionCount;

export function mentionTotal(channels: readonly ChannelSummary[]): number {
  return channels.reduce((sum, channel) => sum + badgeCount(channel), 0);
}

export interface UnreadSummary {
  unread: boolean;
  mentions: number;
}

export function guildUnread(channels: readonly ChannelSummary[], guildId: string): UnreadSummary {
  let unread = false;
  let mentions = 0;
  for (const channel of channels) {
    if (channel.guildId !== guildId) continue;
    unread ||= channel.unreadCount > 0;
    mentions += channel.mentionCount;
  }
  return { unread, mentions: cap(mentions) };
}

export function dmUnread(channels: readonly ChannelSummary[]): UnreadSummary {
  const dms = channels.filter((channel) => channel.kind === 'dm');
  return {
    unread: dms.some((channel) => channel.unreadCount > 0),
    mentions: cap(dms.reduce((sum, channel) => sum + channel.unreadCount, 0)),
  };
}

export const sortGuilds = (guilds: readonly GuildSummary[]): GuildSummary[] =>
  [...guilds].sort((a, b) => a.name.localeCompare(b.name));

export const guildChannels = (channels: readonly ChannelSummary[], guildId: string) =>
  channels
    .filter((channel) => channel.guildId === guildId && channel.kind !== 'dm')
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

/** Most recently active conversation first. */
export const sortDms = (channels: readonly ChannelSummary[]): ChannelSummary[] =>
  channels
    .filter((channel) => channel.kind === 'dm')
    .sort((a, b) => compareIds(b.lastMessageId ?? '0', a.lastMessageId ?? '0'));
