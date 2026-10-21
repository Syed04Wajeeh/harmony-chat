import type { Redis } from 'ioredis';
import {
  PRESENCE_TOPIC,
  channelTopic,
  userTopic,
  type ChannelEvent,
  type PresenceEvent,
  type UserEvent,
} from '@harmony/shared';

/** Every realtime delivery, to local and remote sockets alike, goes through these Redis topics. */
export class EventBus {
  constructor(private readonly redis: Redis) {}

  toChannel(channelId: string, event: ChannelEvent): Promise<unknown> {
    return this.redis.publish(channelTopic(channelId), JSON.stringify(event));
  }

  toUser(userId: string, event: UserEvent): Promise<unknown> {
    return this.redis.publish(userTopic(userId), JSON.stringify(event));
  }

  toEveryone(event: PresenceEvent): Promise<unknown> {
    return this.redis.publish(PRESENCE_TOPIC, JSON.stringify(event));
  }
}
