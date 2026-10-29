import type { Redis } from 'ioredis';
import { WebSocket } from 'ws';
import { PresenceBatcher } from '../presence/batcher.js';
import { topicChangeFor } from '../presence/scope.js';
import {
  CHANNEL_TOPIC_PREFIX,
  ChannelEvent,
  GATEWAY_TOPIC_PREFIX,
  GatewayFrame,
  ModuleFrame,
  PRESENCE_TOPIC_PREFIX,
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
  /** Presence topics of the guilds and DMs this socket's user is in; see presence/scope.ts. */
  readonly presenceTopics: Set<string>;
  /** While set, user events wait behind it so membership changes apply in order. */
  gate: Promise<unknown> | null;
  /** Set for a bot's gateway connection: the topic that carries interactions and events to it. */
  gatewayTopic?: string;
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
 * subscribed channel, one topic per connected user, and one presence topic per guild or DM that
 * a connected user is in. Presence events are not forwarded one by one: the batcher coalesces
 * them per topic and each room gets one `presence.batch` frame per window.
 */
export class Hub {
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Set<HubClient>();
  private readonly listeners = new Map<string, (payload: string) => void>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly batcher: PresenceBatcher;
  /** Called after a socket joins presence topics while connected (guild joined, DM created). */
  onPresenceTopicsJoined: (userId: string, topics: string[]) => Promise<unknown> = () =>
    Promise.resolve();

  constructor(
    private readonly subscriber: Redis,
    private readonly log: HubLogger,
    heartbeatIntervalMs: number,
    presenceBatchMs = 1000,
  ) {
    this.batcher = new PresenceBatcher({
      windowMs: presenceBatchMs,
      onFlush: (topic, updates) => {
        const room = this.rooms.get(topic);
        if (!room) return;
        const json = JSON.stringify({ type: 'presence.batch', updates });
        this.presenceFramesSent += room.clients.size;
        for (const client of room.clients) this.sendJson(client, json);
      },
    });
    subscriber.on('message', (topic: string, payload: string) => this.dispatch(topic, payload));
    this.heartbeat = setInterval(() => this.sweep(), heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  /** `presence.batch` frames handed to sockets since start (for tests and diagnostics). */
  presenceFramesSent = 0;

  add(socket: WebSocket, user: DirectoryUser): HubClient {
    const client: HubClient = {
      socket,
      user,
      channels: new Set(),
      presenceTopics: new Set(),
      gate: null,
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

  /** Subscribes this instance to a Redis topic for its own use, not for sockets. */
  listen(topic: string, listener: (payload: string) => void): Promise<unknown> {
    this.listeners.set(topic, listener);
    return this.subscriber.subscribe(topic);
  }

  /** Resolves once messages published from now on will reach this client. */
  async join(client: HubClient, channelId: string): Promise<void> {
    client.channels.add(channelId);
    await this.enter(channelTopic(channelId), client);
  }

  /** Resolves once frames published to this gateway connection's topic will reach the socket. */
  joinGateway(client: HubClient, topic: string): Promise<unknown> {
    client.gatewayTopic = topic;
    return this.enter(topic, client);
  }

  leave(client: HubClient, channelId: string): void {
    client.channels.delete(channelId);
    this.exit(channelTopic(channelId), client);
  }

  remove(client: HubClient): void {
    this.clients.delete(client);
    for (const channelId of [...client.channels]) this.leave(client, channelId);
    // presenceTopics stays as it was: the connection reads it to say where "offline" goes.
    for (const topic of client.presenceTopics) this.exit(topic, client);
    this.exit(userTopic(client.user.id), client);
    if (client.gatewayTopic) this.exit(client.gatewayTopic, client);
  }

  /**
   * Loads the socket's presence topics (once, at connect) and subscribes to them. User events
   * that arrive meanwhile wait, then apply on top of the loaded set, so a membership change
   * racing the load is never lost.
   */
  loadPresenceTopics(client: HubClient, load: () => Promise<string[]>): Promise<void> {
    const loaded = (async () => {
      await this.joinPresence(client, await load());
    })();
    this.enqueue(client, () => loaded, true);
    return loaded;
  }

  /** Topics of the sockets this user has on this instance, or null if there are none. */
  presenceTopicsOf(userId: string): string[] | null {
    const room = this.rooms.get(userTopic(userId));
    if (!room || room.clients.size === 0) return null;
    const topics = new Set<string>();
    for (const client of room.clients) for (const topic of client.presenceTopics) topics.add(topic);
    return [...topics];
  }

  private joinPresence(client: HubClient, topics: readonly string[]): Promise<unknown> {
    const joined: Promise<unknown>[] = [];
    for (const topic of topics) {
      if (client.presenceTopics.has(topic)) continue;
      client.presenceTopics.add(topic);
      // The newcomer has not been told what was sent before; a flap must not be hidden from it.
      this.batcher.forget(topic);
      joined.push(this.enter(topic, client));
    }
    return Promise.all(joined);
  }

  private leavePresence(client: HubClient, topic: string): void {
    if (client.presenceTopics.delete(topic)) this.exit(topic, client);
  }

  /** Runs a task after anything already queued for this socket; sync when nothing is queued. */
  private enqueue(client: HubClient, task: () => unknown, forceAsync = false): void {
    if (!client.gate && !forceAsync) {
      task();
      return;
    }
    const next: Promise<unknown> = (client.gate ?? Promise.resolve())
      .then(task)
      .catch((err: unknown) => this.log.warn({ err }, 'socket event failed'));
    client.gate = next;
    void next.then(() => {
      if (client.gate === next) client.gate = null;
    });
  }

  send(client: HubClient, frame: ServerFrame): void {
    this.sendJson(client, JSON.stringify(frame));
  }

  /** Sends an already-serialized frame, so fan-out serializes once per event, not per socket. */
  private sendJson(client: HubClient, json: string): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(json);
  }

  /** Closes this instance's sockets of one bot (credentials or scopes changed). */
  closeBot(botId: string, code: number, reason: string): void {
    for (const client of this.clients) {
      if (client.user.isBot && client.user.id === botId) client.socket.close(code, reason);
    }
  }

  closeAll(code: number, reason: string): void {
    clearInterval(this.heartbeat);
    this.batcher.stop();
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
      if (topic.startsWith(PRESENCE_TOPIC_PREFIX)) this.batcher.drop(topic);
      this.subscriber.unsubscribe(topic).catch((err: unknown) => {
        this.log.warn({ err, topic }, 'redis unsubscribe failed');
      });
    }
  }

  private dispatch(topic: string, payload: string): void {
    const listener = this.listeners.get(topic);
    if (listener) {
      listener(payload);
      return;
    }
    try {
      if (topic.startsWith(PRESENCE_TOPIC_PREFIX)) {
        const event = PresenceEvent.parse(JSON.parse(payload));
        if (this.rooms.has(topic)) this.batcher.push(topic, event.userId, event.status);
        return;
      }
      const room = this.rooms.get(topic);
      if (!room) return;
      const json: unknown = JSON.parse(payload);

      if (topic.startsWith(CHANNEL_TOPIC_PREFIX)) {
        // Validated once, serialized once; every local socket gets the same string.
        const out = JSON.stringify(parseChannelFrame(json));
        for (const client of room.clients) this.sendJson(client, out);
      } else if (topic.startsWith(GATEWAY_TOPIC_PREFIX)) {
        const out = JSON.stringify(GatewayFrame.parse(json));
        for (const client of room.clients) this.sendJson(client, out);
      } else if (topic.startsWith(USER_TOPIC_PREFIX)) {
        const core = UserEvent.safeParse(json);
        const out = JSON.stringify(core.success ? core.data : ModuleFrame.parse(json));
        const change = core.success ? topicChangeFor(core.data) : null;
        for (const client of [...room.clients]) {
          // Losing membership ends the live subscription too, not just future subscribes.
          if (core.success && core.data.type === 'channel.removed') {
            this.leave(client, core.data.channelId);
          }
          if (change) this.applyTopicChange(client, change, out);
          else this.enqueue(client, () => this.sendJson(client, out));
        }
      }
    } catch (err) {
      this.log.warn({ err, topic }, 'dropping malformed event');
    }
  }

  /**
   * Presence follows membership: leaving stops delivery at once; joining subscribes first and
   * only then forwards the event that told the client about it, so a client that reacts by
   * fetching the presence snapshot cannot miss an update in between. A joiner then tells the new
   * topic how it is doing.
   */
  private applyTopicChange(
    client: HubClient,
    change: { join: string[]; leave: string[] },
    out: string,
  ): void {
    this.enqueue(
      client,
      async () => {
        for (const topic of change.leave) this.leavePresence(client, topic);
        const fresh = change.join.filter((topic) => !client.presenceTopics.has(topic));
        await this.joinPresence(client, fresh);
        this.sendJson(client, out);
        if (fresh.length > 0) {
          await this.onPresenceTopicsJoined(client.user.id, fresh).catch((err: unknown) => {
            this.log.warn({ err }, 'presence announce failed');
          });
        }
      },
      true,
    );
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

/** Core events first (the hot path); anything else must be a well-formed module frame. */
function parseChannelFrame(json: unknown): ChannelEvent | ModuleFrame {
  const core = ChannelEvent.safeParse(json);
  return core.success ? core.data : ModuleFrame.parse(json);
}
