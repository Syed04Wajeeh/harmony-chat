import type { Redis } from 'ioredis';
import {
  channelTopic,
  userTopic,
  type ChannelEvent,
  type ModuleFrame,
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

  /** Frames from modules; the caller has already checked they belong to the module. */
  moduleToChannel(channelId: string, frame: ModuleFrame): Promise<unknown> {
    return this.redis.publish(channelTopic(channelId), JSON.stringify(frame));
  }

  moduleToUser(userId: string, frame: ModuleFrame): Promise<unknown> {
    return this.redis.publish(userTopic(userId), JSON.stringify(frame));
  }

  /** One round trip however many topics: presence goes to every guild and DM the user is in. */
  toPresenceTopics(topics: readonly string[], event: PresenceEvent): Promise<unknown> {
    const payload = JSON.stringify(event);
    if (topics.length === 1 && topics[0] !== undefined) {
      return this.redis.publish(topics[0], payload);
    }
    const pipeline = this.redis.pipeline();
    for (const topic of topics) pipeline.publish(topic, payload);
    return pipeline.exec();
  }
}
