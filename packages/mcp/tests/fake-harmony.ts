import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Message } from '@harmony/shared';
import { WebSocketServer, type WebSocket } from 'ws';

export const BOT_ID = '900';
export const TOKEN = `hb_${BOT_ID}_${'a'.repeat(43)}`;

export interface FakeUser {
  id: string;
  login: string;
  displayName: string;
  isBot?: boolean;
}

export const ADA: FakeUser = { id: '7', login: 'ada@example.com', displayName: 'Ada' };
export const BOT: FakeUser = {
  id: BOT_ID,
  login: 'harmony-bot',
  displayName: 'Helper',
  isBot: true,
};
export const OTHER_BOT: FakeUser = {
  id: '901',
  login: 'other-bot',
  displayName: 'Other',
  isBot: true,
};
export const BEN: FakeUser = { id: '8', login: 'ben@example.com', displayName: 'Ben' };

interface FakeChannel {
  id: string;
  guildId: string | null;
  name: string | null;
  kind: 'text' | 'dm';
}

/** An in-process stand-in for the parts of the Harmony API the MCP server uses. */
export class FakeHarmony {
  guilds = [
    {
      id: '1',
      name: 'Home',
      iconUrl: null,
      accentColor: null,
      bannerUrl: null,
      description: null,
      ownerId: '7',
      memberCount: 3,
      unreadCount: 0,
      mentionCount: 0,
    },
    {
      id: '2',
      name: 'Work',
      iconUrl: null,
      accentColor: null,
      bannerUrl: null,
      description: null,
      ownerId: '7',
      memberCount: 5,
      unreadCount: 0,
      mentionCount: 0,
    },
  ];
  channels: FakeChannel[] = [
    { id: '11', guildId: '1', name: 'general', kind: 'text' },
    { id: '12', guildId: '1', name: 'ops', kind: 'text' },
    { id: '21', guildId: '2', name: 'general', kind: 'text' },
  ];
  messages = new Map<string, Message[]>();
  requests: { method: string; path: string; body: unknown; authorization?: string | undefined }[] =
    [];
  wsHeaders: IncomingMessageHeaders[] = [];
  /** Answer these `METHOD /path-prefix` requests with an error once. */
  failures: {
    match: string;
    status: number;
    code: string;
    message: string;
    headers?: Record<string, string>;
  }[] = [];
  refuseWebSocket = false;
  private muted = false;
  private nextId = 1000;
  private readonly http: Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly subscribers = new Map<WebSocket, Set<string>>();

  private constructor() {
    this.http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const { status, body, headers } = this.handle(
          req,
          raw ? (JSON.parse(raw) as unknown) : undefined,
        );
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(status === 204 ? undefined : JSON.stringify(body));
      });
    });
    this.http.on('upgrade', (req, socket, head) => {
      this.wsHeaders.push(req.headers);
      if (req.headers.authorization !== `Bot ${TOKEN}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      if (this.refuseWebSocket) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
  }

  static async start(): Promise<FakeHarmony> {
    const fake = new FakeHarmony();
    await new Promise<void>((resolve) => fake.http.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.dropSockets();
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }

  /** Adds a message and delivers it to subscribed sockets, as the server would. */
  post(
    channelId: string,
    author: FakeUser,
    content: string,
    extra: Partial<Message> = {},
  ): Message {
    const id = String(this.nextId++);
    const message: Message = {
      id,
      channelId,
      author: {
        id: author.id,
        login: author.login,
        displayName: author.displayName,
        avatarUrl: null,
        isBot: author.isBot,
      },
      content,
      createdAt: new Date(Date.UTC(2026, 9, 29, 9, 0, 0) + Number(id) * 1000).toISOString(),
      editedAt: null,
      deleted: false,
      pinnedAt: null,
      pinnedBy: null,
      replyTo: null,
      reactions: [],
      attachments: [],
      mentions: [],
      ...extra,
    };
    this.store(channelId).push(message);
    this.broadcast(message);
    return message;
  }

  /** Stores a message without telling sockets (it arrives only by backfill or polling). */
  postQuietly(channelId: string, author: FakeUser, content: string): Message {
    this.muted = true;
    try {
      return this.post(channelId, author, content);
    } finally {
      this.muted = false;
    }
  }

  dropSockets(): void {
    for (const ws of this.subscribers.keys()) ws.terminate();
    this.subscribers.clear();
  }

  get socketCount(): number {
    return this.subscribers.size;
  }

  private store(channelId: string): Message[] {
    let list = this.messages.get(channelId);
    if (!list) this.messages.set(channelId, (list = []));
    return list;
  }

  private broadcast(message: Message): void {
    if (this.muted) return;
    for (const [ws, channelIds] of this.subscribers) {
      if (channelIds.has(message.channelId) && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'message.created', message }));
      }
    }
  }

  private onSocket(ws: WebSocket): void {
    const channelIds = new Set<string>();
    this.subscribers.set(ws, channelIds);
    ws.send(JSON.stringify({ type: 'hello', user: BOT, instanceId: 'fake' }));
    ws.on('close', () => this.subscribers.delete(ws));
    ws.on('message', (data) => {
      const frame = JSON.parse((data as Buffer).toString('utf8')) as {
        type: string;
        channelId: string;
        lastSeenId?: string;
      };
      if (frame.type !== 'subscribe') return;
      if (!this.channels.some((c) => c.id === frame.channelId)) {
        ws.send(
          JSON.stringify({
            type: 'error',
            code: 'forbidden',
            message: 'You are not a member of this channel',
          }),
        );
        return;
      }
      channelIds.add(frame.channelId);
      const newer = this.store(frame.channelId).filter(
        (m) => frame.lastSeenId !== undefined && BigInt(m.id) > BigInt(frame.lastSeenId),
      );
      ws.send(
        JSON.stringify({
          type: 'backfill',
          channelId: frame.channelId,
          messages: newer,
          hasMore: false,
        }),
      );
    });
  }

  private handle(
    req: IncomingMessage,
    body: unknown,
  ): { status: number; body?: unknown; headers?: Record<string, string> } {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = `${req.method} ${url.pathname}`;
    this.requests.push({
      method: req.method ?? '',
      path: url.pathname + url.search,
      body,
      authorization: req.headers.authorization,
    });
    if (req.headers.authorization !== `Bot ${TOKEN}`) {
      return { status: 401, body: { code: 'invalid_token', message: 'Invalid bot token' } };
    }
    const failure = this.failures.findIndex((f) => key.startsWith(f.match));
    if (failure >= 0) {
      const [f] = this.failures.splice(failure, 1);
      if (f)
        return { status: f.status, body: { code: f.code, message: f.message }, headers: f.headers };
    }
    const channelMatch = /^\/api\/channels\/(\d+)\/messages$/.exec(url.pathname);
    if (key === 'GET /api/guilds') return { status: 200, body: { guilds: this.guilds } };
    if (key === 'GET /api/channels') {
      return { status: 200, body: { channels: this.channels.map((c) => this.summary(c)) } };
    }
    const guildMatch = /^\/api\/guilds\/(\d+)\/channels$/.exec(url.pathname);
    if (req.method === 'GET' && guildMatch) {
      const list = this.channels.filter((c) => c.guildId === guildMatch[1]);
      return { status: 200, body: { channels: list.map((c) => this.summary(c)) } };
    }
    if (channelMatch?.[1]) {
      const channelId = channelMatch[1];
      if (!this.channels.some((c) => c.id === channelId)) {
        return { status: 404, body: { code: 'channel_not_found', message: 'Channel not found' } };
      }
      if (req.method === 'GET') {
        const before = url.searchParams.get('before');
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const all = this.store(channelId).filter((m) => !before || BigInt(m.id) < BigInt(before));
        return { status: 200, body: { messages: all.slice(-limit), hasMore: all.length > limit } };
      }
      const input = body as { content: string; replyToId?: string };
      const replyTo = input.replyToId
        ? this.store(channelId).find((m) => m.id === input.replyToId)
        : undefined;
      if (input.replyToId && !replyTo) {
        return { status: 400, body: { code: 'invalid_reply', message: 'Reply target not found' } };
      }
      const message = this.post(channelId, BOT, input.content, {
        replyTo: replyTo
          ? {
              id: replyTo.id,
              authorId: replyTo.author.id,
              contentPreview: replyTo.content.slice(0, 100),
              deleted: false,
            }
          : null,
      });
      return { status: 201, body: message };
    }
    const reaction = /^\/api\/messages\/(\d+)\/reactions\/(.+)$/.exec(url.pathname);
    if (req.method === 'PUT' && reaction) return { status: 204 };
    if (key === 'GET /api/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const channelId = url.searchParams.get('channelId');
      const hits = [...this.messages.values()]
        .flat()
        .filter(
          (m) => m.content.toLowerCase().includes(q) && (!channelId || m.channelId === channelId),
        )
        .reverse();
      return { status: 200, body: { messages: hits, hasMore: false } };
    }
    return { status: 404, body: { code: 'not_found', message: 'No such route' } };
  }

  private summary(c: FakeChannel) {
    return {
      ...c,
      topic: null,
      isPrivate: false,
      createdBy: null,
      dmUser: null,
      unreadCount: 0,
      mentionCount: 0,
      lastMessageId: null,
      lastReadMessageId: null,
    };
  }
}

type IncomingMessageHeaders = IncomingMessage['headers'];
