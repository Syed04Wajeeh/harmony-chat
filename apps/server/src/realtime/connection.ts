import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import {
  BACKFILL_LIMIT,
  ClientFrame,
  type BotScope,
  type DirectoryUser,
  type ServerFrame,
} from '@harmony/shared';
import type { BotPrincipal } from '../bots/auth.js';
import type { InteractionService } from '../commands/interactions.js';
import type { UserStore } from '../auth/user-store.js';
import type { ChannelService } from '../channels/service.js';
import { AppError } from '../errors.js';
import type { MessageService } from '../messages/service.js';
import type { PresenceService } from '../presence/service.js';
import type { Hub } from './hub.js';
import { TokenBucket } from './token-bucket.js';
import type { TypingService } from './typing.js';

export interface ConnectionDeps {
  hub: Hub;
  channels: ChannelService;
  messages: MessageService;
  users: UserStore;
  presence: PresenceService;
  typing: TypingService;
  interactions: InteractionService;
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
  const bucket = new TokenBucket(deps.frameBurst, deps.frameRefillPerSecond);
  let violations = 0;
  connLog.info('websocket connected');

  async function handle(frame: ClientFrame): Promise<void> {
    requireFrameAccess(bot, frame);
    switch (frame.type) {
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
        await typing.notify(user.id, frame.channelId);
        return;
      case 'presence.set':
        await users.setStatus(user.id, frame.status);
        await presence.statusChanged(user.id, frame.status);
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
    const frame = isBinary ? null : parseClientFrame(rawToString(data));
    if (!frame) {
      send({ type: 'error', code: 'invalid_frame', message: 'Malformed frame' });
      return;
    }
    const nonce =
      frame.type === 'message.send' || (frame.type === 'command.invoke' && frame.nonce)
        ? { nonce: frame.nonce }
        : {};
    try {
      await handle(frame);
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
    await presence.touch(user.id, connectionId).catch((err: unknown) => {
      connLog.warn({ err }, 'presence update failed');
    });
    // The socket may have closed while we were setting up; don't leave a ghost connection.
    if (socket.readyState !== socket.OPEN) await presence.disconnect(user.id, connectionId);
    send({ type: 'hello', user: await users.getMe(user), instanceId });
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

  socket.on('close', (code) => {
    clearInterval(heartbeat);
    hub.remove(client);
    presence.disconnect(user.id, connectionId).catch((err: unknown) => {
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
};

function requireFrameAccess(bot: BotPrincipal | null, frame: ClientFrame): void {
  if (!bot || frame.type === 'unsubscribe') return;
  const scope = FRAME_SCOPES[frame.type];
  if (!scope) throw new AppError(403, 'human_only', 'Bots cannot send this frame');
  if (!bot.scopes.includes(scope)) {
    throw new AppError(403, 'missing_scope', `This bot lacks the ${scope} scope`);
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}
