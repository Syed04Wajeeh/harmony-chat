import type { Redis } from 'ioredis';
import { WebSocket } from 'ws';
import {
  CHANNEL_TOPIC_PREFIX,
  ChannelEvent,
  PRESENCE_TOPIC,
  PresenceEvent,
  USER_TOPIC_PREFIX,
  UserEvent,
  channelTopic,
  userTopic,
  type DirectoryUser,
  type ServerFrame,
} from '@harmony/shared';

export interface HubClient {
  readonly socket: WebSocket;
  readonly user: DirectoryUser;
  readonly channels: Set<string>;
  alive: boolean;
  /** Resolves once the client's per-user topic is live, so no event addressed to it is missed. */
  ready: Promise<unknown>;
}

interface Room {
  clients: Set<HubClient>;
  /** Resolves once the Redis SUBSCRIBE for this room has been acknowledged. */
  ready: Promise<unknown>;
}

export interface HubLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Tracks the sockets connected to this instance and fans Redis messages out to them. A Redis
 * topic is subscribed while at least one local socket is in its room: channel topics per
 * subscribed channel, one topic per connected user, and the global presence topic always.
 */
export class Hub {
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Set<HubClient>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly subscriber: Redis,
    private readonly log: HubLogger,
    heartbeatIntervalMs: number,
  ) {
    subscriber.on('message', (topic: string, payload: string) => this.dispatch(topic, payload));
    subscriber.subscribe(PRESENCE_TOPIC).catch((err: unknown) => {
      this.log.warn({ err }, 'presence subscribe failed');
    });
    this.heartbeat = setInterval(() => this.sweep(), heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  add(socket: WebSocket, user: DirectoryUser): HubClient {
    const client: HubClient = {
      socket,
      user,
      channels: new Set(),
      alive: true,
      ready: Promise.resolve(),
    };
    socket.on('pong', () => {
      client.alive = true;
    });
    this.clients.add(client);
    client.ready = this.enter(userTopic(user.id), client);
    return client;
  }

  /** Resolves once messages published from now on will reach this client. */
  async join(client: HubClient, channelId: string): Promise<void> {
    client.channels.add(channelId);
    await this.enter(channelTopic(channelId), client);
  }

  leave(client: HubClient, channelId: string): void {
    client.channels.delete(channelId);
    this.exit(channelTopic(channelId), client);
  }

  remove(client: HubClient): void {
    this.clients.delete(client);
    for (const channelId of [...client.channels]) this.leave(client, channelId);
    this.exit(userTopic(client.user.id), client);
  }

  send(client: HubClient, frame: ServerFrame): void {
    this.sendJson(client, JSON.stringify(frame));
  }

  /** Sends an already-serialized frame, so fan-out serializes once per event, not per socket. */
  private sendJson(client: HubClient, json: string): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(json);
  }

  closeAll(code: number, reason: string): void {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.socket.close(code, reason);
  }

  private enter(topic: string, client: HubClient): Promise<unknown> {
    let room = this.rooms.get(topic);
    if (!room) {
      room = { clients: new Set(), ready: this.subscriber.subscribe(topic) };
      this.rooms.set(topic, room);
    }
    room.clients.add(client);
    return room.ready;
  }

  private exit(topic: string, client: HubClient): void {
    const room = this.rooms.get(topic);
    if (!room) return;
    room.clients.delete(client);
    if (room.clients.size === 0) {
      this.rooms.delete(topic);
      this.subscriber.unsubscribe(topic).catch((err: unknown) => {
        this.log.warn({ err, topic }, 'redis unsubscribe failed');
      });
    }
  }

  private dispatch(topic: string, payload: string): void {
    try {
      if (topic === PRESENCE_TOPIC) {
        const json = JSON.stringify(PresenceEvent.parse(JSON.parse(payload)));
        for (const client of this.clients) this.sendJson(client, json);
        return;
      }
      const room = this.rooms.get(topic);
      if (!room) return;
      const json: unknown = JSON.parse(payload);

      if (topic.startsWith(CHANNEL_TOPIC_PREFIX)) {
        // Validated once, serialized once; every local socket gets the same string.
        const out = JSON.stringify(ChannelEvent.parse(json));
        for (const client of room.clients) this.sendJson(client, out);
      } else if (topic.startsWith(USER_TOPIC_PREFIX)) {
        const frame = UserEvent.parse(json);
        for (const client of [...room.clients]) {
          // Losing membership ends the live subscription too, not just future subscribes.
          if (frame.type === 'channel.removed') this.leave(client, frame.channelId);
          this.send(client, frame);
        }
      }
    } catch (err) {
      this.log.warn({ err, topic }, 'dropping malformed event');
    }
  }

  private sweep(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }
}
