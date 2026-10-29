import type { Redis } from 'ioredis';
import {
  channelTopic,
  userTopic,
  type ChannelEvent,
  type ModuleFrame,
  type PresenceEvent,
  type UserEvent,
} from '@harmony/shared';

export const REVOKE_TOPIC = 'harmony:gateway:revoke';
/** Close code for a socket whose credentials or scopes were revoked. */
export const REVOKED_CLOSE_CODE = 4001;

/** Every realtime delivery, to local and remote sockets alike, goes through these Redis topics. */
export class EventBus {
  constructor(private readonly redis: Redis) {}

  toChannel(channelId: string, event: ChannelEvent): Promise<unknown> {
    return this.redis.publish(channelTopic(channelId), JSON.stringify(event));
  }

  toUser(userId: string, event: UserEvent): Promise<unknown> {
    return this.redis.publish(userTopic(userId), JSON.stringify(event));
  }

  /** Tells every instance to close the bot's open sockets; see `REVOKE_TOPIC`. */
  revokeBot(botId: string, reason: string): Promise<unknown> {
    return this.redis.publish(REVOKE_TOPIC, JSON.stringify({ botId, reason }));
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
