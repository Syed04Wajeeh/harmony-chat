import type { Redis } from 'ioredis';
import { WebSocket } from 'ws';
import {
  MESSAGE_CHANNEL_PREFIX,
  MessageEnvelope,
  type ServerFrame,
  type User,
} from '@harmony/shared';
import { redisChannelFor } from '../messages/service.js';

export interface HubClient {
  readonly socket: WebSocket;
  readonly user: User;
  readonly channels: Set<string>;
  alive: boolean;
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
 * Tracks the sockets connected to this instance and fans Redis messages out to them.
 * A Redis channel is subscribed while at least one local socket is in the room.
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
    subscriber.on('message', (redisChannel: string, payload: string) =>
      this.dispatch(redisChannel, payload),
    );
    this.heartbeat = setInterval(() => this.sweep(), heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  add(socket: WebSocket, user: User): HubClient {
    const client: HubClient = { socket, user, channels: new Set(), alive: true };
    socket.on('pong', () => {
      client.alive = true;
    });
    this.clients.add(client);
    return client;
  }

  /** Resolves once messages published from now on will reach this client. */
  async join(client: HubClient, channelId: string): Promise<void> {
    let room = this.rooms.get(channelId);
    if (!room) {
      room = {
        clients: new Set(),
        ready: this.subscriber.subscribe(redisChannelFor(channelId)),
      };
      this.rooms.set(channelId, room);
    }
    room.clients.add(client);
    client.channels.add(channelId);
    await room.ready;
  }

  leave(client: HubClient, channelId: string): void {
    client.channels.delete(channelId);
    const room = this.rooms.get(channelId);
    if (!room) return;
    room.clients.delete(client);
    if (room.clients.size === 0) {
      this.rooms.delete(channelId);
      this.subscriber.unsubscribe(redisChannelFor(channelId)).catch((err: unknown) => {
        this.log.warn({ err, channelId }, 'redis unsubscribe failed');
      });
    }
  }

  remove(client: HubClient): void {
    this.clients.delete(client);
    for (const channelId of [...client.channels]) this.leave(client, channelId);
  }

  send(client: HubClient, frame: ServerFrame): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(frame));
  }

  closeAll(code: number, reason: string): void {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.socket.close(code, reason);
  }

  private dispatch(redisChannel: string, payload: string): void {
    const channelId = redisChannel.slice(MESSAGE_CHANNEL_PREFIX.length);
    const room = this.rooms.get(channelId);
    if (!room) return;

    let envelope: MessageEnvelope;
    try {
      envelope = MessageEnvelope.parse(JSON.parse(payload));
    } catch (err) {
      this.log.warn({ err, channelId }, 'dropping malformed envelope');
      return;
    }
    // The nonce lets the sender's other frames reconcile with its optimistic copy.
    const frame: ServerFrame = {
      type: 'message.created',
      message: envelope.message,
      ...(envelope.nonce && { nonce: envelope.nonce }),
    };
    for (const client of room.clients) this.send(client, frame);
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
