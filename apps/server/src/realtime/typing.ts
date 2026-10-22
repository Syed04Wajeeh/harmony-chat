import type { Redis } from 'ioredis';
import type { DirectoryUser } from '@harmony/shared';
import type { ChannelService } from '../channels/service.js';
import type { PermissionService } from '../permissions/service.js';
import type { EventBus } from './events.js';

const THROTTLE_MS = 2000;

/** Relays "is typing" pings. They are published on the channel topic and never stored. */
export class TypingService {
  constructor(
    private readonly redis: Redis,
    private readonly events: EventBus,
    private readonly channels: ChannelService,
    private readonly perms: PermissionService,
  ) {}

  /**
   * At most one relay per user and channel every 2 seconds, across all of the user's sockets
   * and all instances (a Redis SET NX with a TTL); extra pings are silently dropped. The
   * throttle runs before the membership check so a flood costs one Redis command, not a query.
   */
  async notify(user: Pick<DirectoryUser, 'id' | 'isAdmin'>, channelId: string): Promise<void> {
    const key = `harmony:typing:${channelId}:${user.id}`;
    const first = await this.redis.set(key, '1', 'PX', THROTTLE_MS, 'NX');
    if (first !== 'OK') return;
    const channel = await this.channels.requireMember(channelId, user.id);
    // Someone who cannot send has nothing to type; drop the ping rather than answer an error.
    if (
      channel.guild_id &&
      !(await this.perms.has(user, channel.guild_id, 'send_messages', channelId))
    ) {
      return;
    }
    await this.events.toChannel(channelId, { type: 'typing', channelId, userId: user.id });
  }
}
