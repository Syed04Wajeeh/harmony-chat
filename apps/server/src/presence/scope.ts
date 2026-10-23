import { presenceDmTopic, presenceGuildTopic } from '@harmony/shared';

/** What decides whose presence a user sees: the guilds and DMs they are in. */
export interface Memberships {
  guildIds: readonly string[];
  /** Each DM channel with the other participant. */
  dms: readonly { channelId: string; peerId: string }[];
}

/**
 * The presence topics of a user. A user sees the presence of everyone who publishes to one of
 * these topics, and publishes their own presence to the same topics, so visibility is symmetric.
 */
export function presenceTopicsOf(memberships: Memberships): string[] {
  return [
    ...memberships.guildIds.map(presenceGuildTopic),
    ...memberships.dms.map((dm) => presenceDmTopic(dm.channelId)),
  ];
}

export interface TopicChange {
  join: string[];
  leave: string[];
}

/** The per-user events that change a socket's presence topics; anything else returns null. */
export function topicChangeFor(event: {
  type: string;
  guild?: { id: string };
  guildId?: string;
  channel?: { id: string; kind: string };
  channelId?: string;
}): TopicChange | null {
  switch (event.type) {
    case 'guild.joined':
      return event.guild ? { join: [presenceGuildTopic(event.guild.id)], leave: [] } : null;
    case 'guild.removed':
      return event.guildId ? { join: [], leave: [presenceGuildTopic(event.guildId)] } : null;
    case 'channel.joined':
      return event.channel?.kind === 'dm'
        ? { join: [presenceDmTopic(event.channel.id)], leave: [] }
        : null;
    case 'channel.removed':
      // Only a DM id matches a DM topic; for any other channel this leaves nothing.
      return event.channelId ? { join: [], leave: [presenceDmTopic(event.channelId)] } : null;
    default:
      return null;
  }
}

/** A user is shown as offline when invisible. */
export function effectiveStatus(chosen: string): 'online' | 'idle' | 'dnd' | 'offline' {
  return chosen === 'invisible' ? 'offline' : (chosen as 'online' | 'idle' | 'dnd');
}
