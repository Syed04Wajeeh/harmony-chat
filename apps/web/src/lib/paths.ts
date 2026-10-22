import type { ChannelSummary } from '@harmony/shared';
import { guildChannels, sortDms } from '../store/selectors.js';
import { lastChannelFor } from './storage.js';

export const HOME = '@me';

export const channelPath = (channel: Pick<ChannelSummary, 'id' | 'guildId'>): string =>
  `/channels/${channel.guildId ?? HOME}/${channel.id}`;

/** Where the guild rail should send you: the channel you last used there, else the first one. */
export function guildPath(guildId: string, channels: readonly ChannelSummary[]): string {
  const inGuild = guildChannels(channels, guildId);
  const remembered = inGuild.find((channel) => channel.id === lastChannelFor(guildId));
  const target = remembered ?? inGuild.find((channel) => channel.name === 'general') ?? inGuild[0];
  return target ? channelPath(target) : `/channels/${guildId}`;
}

export function homePath(channels: readonly ChannelSummary[]): string {
  const dms = sortDms(channels);
  const remembered = dms.find((channel) => channel.id === lastChannelFor(HOME));
  return remembered ? channelPath(remembered) : `/channels/${HOME}`;
}
