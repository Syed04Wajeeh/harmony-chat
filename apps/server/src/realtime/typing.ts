import type { Redis } from 'ioredis';
import type { ChannelService } from '../channels/service.js';
import type { EventBus } from './events.js';

const THROTTLE_MS = 2000;

/** Relays "is typing" pings. They are published on the channel topic and never stored. */
export class TypingService {
  constructor(
    private readonly redis: Redis,
    private readonly events: EventBus,
    private readonly channels: ChannelService,
  ) {}

  /**
   * At most one relay per user and channel every 2 seconds, across all of the user's sockets
   * and all instances (a Redis SET NX with a TTL); extra pings are silently dropped. The
   * throttle runs before the membership check so a flood costs one Redis command, not a query.
   */
  async notify(userId: string, channelId: string): Promise<void> {
    const key = `harmony:typing:${channelId}:${userId}`;
    const first = await this.redis.set(key, '1', 'PX', THROTTLE_MS, 'NX');
    if (first !== 'OK') return;
    await this.channels.requireMember(channelId, userId);
    await this.events.toChannel(channelId, { type: 'typing', channelId, userId });
  }
}
