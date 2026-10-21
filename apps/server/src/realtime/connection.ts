import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { BACKFILL_LIMIT, ClientFrame, type ServerFrame, type User } from '@harmony/shared';
import type { ChannelService } from '../channels/service.js';
import { AppError } from '../errors.js';
import type { MessageService } from '../messages/service.js';
import type { Hub } from './hub.js';

export interface ConnectionDeps {
  hub: Hub;
  channels: ChannelService;
  messages: MessageService;
  instanceId: string;
}

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
  user: User,
  log: FastifyBaseLogger,
  { hub, channels, messages, instanceId }: ConnectionDeps,
): void {
  const client = hub.add(socket, user);
  const send = (frame: ServerFrame) => hub.send(client, frame);
  const connLog = log.child({ user: user.login, instanceId });
  connLog.info('websocket connected');

  async function handle(frame: ClientFrame): Promise<void> {
    switch (frame.type) {
      case 'subscribe': {
        if (!(await channels.exists(frame.channelId))) {
          throw new AppError(404, 'channel_not_found', 'Channel not found');
        }
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
        });
        send({ type: 'ack', nonce: frame.nonce, message });
        return;
      }
    }
  }

  // Frames are handled one at a time so a subscribe is always settled before the next send.
  let queue = Promise.resolve();
  socket.on('message', (data: RawData, isBinary: boolean) => {
    queue = queue.then(async () => {
      const frame = isBinary ? null : parseClientFrame(rawToString(data));
      if (!frame) {
        send({ type: 'error', code: 'invalid_frame', message: 'Malformed frame' });
        return;
      }
      const nonce = frame.type === 'message.send' ? { nonce: frame.nonce } : {};
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
    });
  });

  socket.on('close', (code) => {
    hub.remove(client);
    connLog.info({ code }, 'websocket disconnected');
  });
  socket.on('error', (err) => connLog.warn({ err }, 'websocket error'));

  send({ type: 'hello', user, instanceId });
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}
