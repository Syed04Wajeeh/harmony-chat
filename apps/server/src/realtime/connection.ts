import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import {
  BACKFILL_LIMIT,
  ClientFrame,
  gatewayTopic,
  type BotScope,
  type DirectoryUser,
  type ServerFrame,
} from '@harmony/shared';
import type { Kysely } from 'kysely';
import type { BotPrincipal } from '../bots/auth.js';
import type { Database } from '../db/schema.js';
import type { GatewayBus } from '../gateway/bus.js';
import { ackUpTo, resume } from '../gateway/events.js';
import type { GatewayInteractions } from '../gateway/interactions.js';
import type { InteractionService } from '../commands/interactions.js';
import type { UserStore } from '../auth/user-store.js';
import type { ChannelService } from '../channels/service.js';
import { AppError } from '../errors.js';
import type { MessageService } from '../messages/service.js';
import type { ModuleFrames, WsFrameHandler } from '../modules/ws-frames.js';
import type { PresenceService } from '../presence/service.js';
import type { Hub } from './hub.js';
import { TokenBucket } from './token-bucket.js';
import type { TypingService } from './typing.js';

export interface GatewayDeps {
  db: Kysely<Database>;
  bus: GatewayBus;
  interactions: GatewayInteractions;
  /** How often a gateway connection refreshes its presence entry. */
  heartbeatMs: number;
  /** Inbound frame budget for gateway bots, who answer every interaction and ack events. */
  frameBurst: number;
  frameRefillPerSecond: number;
}

export interface ConnectionDeps {
  gateway: GatewayDeps;
  hub: Hub;
  channels: ChannelService;
  messages: MessageService;
  users: UserStore;
  presence: PresenceService;
  typing: TypingService;
  interactions: InteractionService;
  /** Frame types contributed by modules. */
  frames: ModuleFrames;
  instanceId: string;
  presenceHeartbeatMs: number;
  frameBurst: number;
  frameRefillPerSecond: number;
}

/** Close a socket that keeps flooding after being told to stop. */
const MAX_RATE_VIOLATIONS = 100;

export function parseClientFrame(raw: string): ClientFrame | null {
  try {
    const result = ClientFrame.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function handleConnection(
  socket: WebSocket,
  user: DirectoryUser,
  bot: BotPrincipal | null,
  log: FastifyBaseLogger,
  deps: ConnectionDeps,
): void {
  const { hub, channels, messages, users, presence, typing, interactions, instanceId } = deps;
  const client = hub.add(socket, user);
  const send = (frame: ServerFrame) => hub.send(client, frame);
  const connLog = log.child({ user: user.login, instanceId });
  const connectionId = randomUUID();
  // A bot with the commands or events scope may be a gateway bot: it receives interactions and
  // events on this socket while it is connected.
  const isGateway =
    bot !== null && (bot.scopes.includes('commands') || bot.scopes.includes('events'));
  const gw = deps.gateway;
  let gatewayMember: string | null = null;
  const bucket = isGateway
    ? new TokenBucket(gw.frameBurst, gw.frameRefillPerSecond)
    : new TokenBucket(deps.frameBurst, deps.frameRefillPerSecond);
  let violations = 0;
  connLog.info('websocket connected');

  async function handle(frame: ClientFrame): Promise<void> {
    requireFrameAccess(bot, frame);
    switch (frame.type) {
      case 'interaction.respond':
        await gw.interactions.respond(user.id, frame);
        return;
      case 'event.ack':
        await ackUpTo(gw.db, user.id, frame.seq);
        return;
      case 'resume': {
        const replayed = await resume(gw.db, gw.bus, user.id, connectionId, frame.lastSeq);
        send({ type: 'resumed', lastSeq: frame.lastSeq, replayed });
        return;
      }
      case 'subscribe': {
        await channels.requireMember(frame.channelId, user.id);
        // Join Redis first, then read Postgres: a message published in between is delivered
        // live and also appears in the backfill, which the client dedupes by id.
        await hub.join(client, frame.channelId);
        const page = frame.lastSeenId
          ? await messages.since(frame.channelId, frame.lastSeenId, BACKFILL_LIMIT)
          : { messages: [], hasMore: false };
        send({ type: 'backfill', channelId: frame.channelId, ...page });
        return;
      }
      case 'unsubscribe':
        hub.leave(client, frame.channelId);
        return;
      case 'message.send': {
        const message = await messages.send({
          author: user,
          channelId: frame.channelId,
          content: frame.content,
          nonce: frame.nonce,
          replyToId: frame.replyToId,
          attachmentIds: frame.attachmentIds,
        });
        send({ type: 'ack', nonce: frame.nonce, message });
        return;
      }
      case 'read':
        await channels.markRead(user, frame.channelId, frame.messageId);
        return;
      case 'typing':
        await typing.notify(user, frame.channelId);
        return;
      case 'presence.set':
        await users.setStatus(user.id, frame.status);
        await presence.statusChanged(user.id, frame.status);
        return;
      case 'action.invoke':
        await interactions.invokeAction(user, {
          source: frame.source,
          actionId: frame.actionId,
          ...(frame.nonce && { nonce: frame.nonce }),
        });
        return;
      case 'command.invoke':
        await interactions.invoke(user, frame.channelId, {
          name: frame.name,
          options: frame.options,
          ...(frame.nonce && { nonce: frame.nonce }),
        });
        return;
    }
  }

  async function handleRaw(data: RawData, isBinary: boolean): Promise<void> {
    const text = isBinary ? null : rawToString(data);
    const frame = text === null ? null : parseClientFrame(text);
    const fromModule = frame || text === null ? null : parseModuleFrame(text, deps.frames);
    if (!frame && !fromModule) {
      send({ type: 'error', code: 'invalid_frame', message: 'Malformed frame' });
      return;
    }
    if (fromModule === 'invalid') {
      send({ type: 'error', code: 'invalid_frame', message: 'Malformed frame' });
      return;
    }
    const nonce =
      frame &&
      (frame.type === 'message.send' ||
        ((frame.type === 'command.invoke' || frame.type === 'action.invoke') && frame.nonce))
        ? { nonce: frame.nonce }
        : {};
    try {
      if (frame) await handle(frame);
      else if (fromModule) {
        requireModuleAccess(bot, fromModule.handler);
        await fromModule.handler.run(fromModule.frame, { user, bot, log: connLog });
      }
    } catch (error) {
      if (error instanceof AppError) {
        send({ type: 'error', code: error.code, message: error.message, ...nonce });
      } else {
        connLog.error({ err: error }, 'websocket frame handler failed');
        send({ type: 'error', code: 'internal', message: 'Internal error', ...nonce });
      }
    }
  }

  // Frames are handled one at a time so a subscribe is always settled before the next send.
  // The queue starts with the greeting, so nothing is processed before the user topic is live.
  let queue = (async () => {
    await client.ready;
    // Join the presence topics of the user's guilds and DMs before anything is announced or
    // answered, so a client that fetches the presence snapshot after `hello` misses nothing.
    const [me] = await Promise.all([
      users.getMe(user),
      hub.loadPresenceTopics(client, () => presence.topicsOf(user.id)),
    ]);
    await presence
      .touch(user.id, connectionId, { status: me.status, topics: [...client.presenceTopics] })
      .catch((err: unknown) => {
        connLog.warn({ err }, 'presence update failed');
      });
    // The socket may have closed while we were setting up; don't leave a ghost connection.
    if (socket.readyState !== socket.OPEN) {
      await presence.disconnect(user.id, connectionId, [...client.presenceTopics]);
    }
    if (isGateway) {
      // Subscribe first, then announce: once `hello` is out, frames published for this
      // connection reach it.
      await hub.joinGateway(client, gatewayTopic(connectionId));
      gatewayMember = await gw.bus.connect(user.id, connectionId);
      if (!gatewayMember) {
        send({
          type: 'error',
          code: 'too_many_connections',
          message: 'This bot has too many gateway connections',
        });
        socket.close(1008, 'too many gateway connections');
        return;
      }
      if (socket.readyState !== socket.OPEN) {
        // Closed while registering: the close handler ran before there was anything to undo.
        hub.remove(client);
        await gw.bus.disconnect(user.id, gatewayMember);
        gatewayMember = null;
      }
    }
    send({ type: 'hello', user: me, instanceId });
  })().catch((err: unknown) => {
    connLog.error({ err }, 'websocket setup failed');
    socket.close(1011, 'setup failed');
  });

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (!bucket.take()) {
      if (++violations > MAX_RATE_VIOLATIONS) socket.close(1008, 'too many frames');
      else send({ type: 'error', code: 'rate_limited', message: 'Too many frames' });
      return;
    }
    queue = queue.then(() => handleRaw(data, isBinary));
  });

  const heartbeat = setInterval(() => {
    presence.touch(user.id, connectionId).catch((err: unknown) => {
      connLog.warn({ err }, 'presence heartbeat failed');
    });
  }, deps.presenceHeartbeatMs);
  heartbeat.unref();
  const gatewayBeat = setInterval(() => {
    if (gatewayMember) {
      gw.bus.touch(user.id, gatewayMember).catch((err: unknown) => {
        connLog.warn({ err }, 'gateway heartbeat failed');
      });
    }
  }, gw.heartbeatMs);
  gatewayBeat.unref();

  socket.on('close', (code) => {
    clearInterval(heartbeat);
    clearInterval(gatewayBeat);
    if (gatewayMember) {
      gw.bus.disconnect(user.id, gatewayMember).catch((err: unknown) => {
        connLog.warn({ err }, 'gateway disconnect failed');
      });
      gatewayMember = null;
    }
    const topics = [...client.presenceTopics];
    hub.remove(client);
    presence.disconnect(user.id, connectionId, topics).catch((err: unknown) => {
      connLog.warn({ err }, 'presence disconnect failed');
    });
    connLog.info({ code }, 'websocket disconnected');
  });
  socket.on('error', (err) => connLog.warn({ err }, 'websocket error'));
}

/** Scope each frame needs from a bot; frames absent here are human-only. Humans pass through. */
const FRAME_SCOPES: Partial<Record<ClientFrame['type'], BotScope>> = {
  subscribe: 'messages.read',
  'message.send': 'messages.write',
  typing: 'messages.write',
  'interaction.respond': 'commands',
  'event.ack': 'events',
  resume: 'events',
};

const BOT_ONLY_FRAMES: ReadonlySet<ClientFrame['type']> = new Set([
  'interaction.respond',
  'event.ack',
  'resume',
]);

function requireFrameAccess(bot: BotPrincipal | null, frame: ClientFrame): void {
  if (!bot && BOT_ONLY_FRAMES.has(frame.type)) {
    throw new AppError(403, 'bot_only', 'Only bots can send this frame');
  }
  if (!bot || frame.type === 'unsubscribe') return;
  const scope = FRAME_SCOPES[frame.type];
  if (!scope) throw new AppError(403, 'human_only', 'Bots cannot send this frame');
  if (!bot.scopes.includes(scope)) {
    throw new AppError(403, 'missing_scope', `This bot lacks the ${scope} scope`);
  }
}

function parseModuleFrame(
  raw: string,
  frames: ModuleFrames,
): { handler: WsFrameHandler; frame: unknown } | 'invalid' | null {
  try {
    return frames.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Bots may send a module's frame only if the module names a scope for it and the bot holds it. */
function requireModuleAccess(bot: BotPrincipal | null, handler: WsFrameHandler): void {
  if (!bot) return;
  if (!handler.scope) throw new AppError(403, 'human_only', 'Bots cannot send this frame');
  if (!bot.scopes.includes(handler.scope)) {
    throw new AppError(403, 'missing_scope', `This bot lacks the ${handler.scope} scope`);
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}
