import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Bot } from '@harmony/shared';
import { api, type TestApp } from './harness.js';

export interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  at: number;
}

export interface Reply {
  status?: number;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
}

/** A local HTTP server standing in for a bot's interactions and events endpoints. */
export class Receiver {
  readonly requests: Received[] = [];
  handler: (request: Received) => Reply | Promise<Reply> = () => ({ status: 200, body: {} });
  private constructor(private readonly server: Server) {}

  static async start(): Promise<Receiver> {
    const holder: { receiver?: Receiver } = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        void (async () => {
          const received: Received = {
            path: req.url ?? '/',
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            at: Date.now(),
          };
          holder.receiver?.requests.push(received);
          const reply = (await holder.receiver?.handler(received)) ?? {};
          if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
          if (res.destroyed) return;
          res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
          res.end(reply.rawBody ?? JSON.stringify(reply.body ?? {}));
        })();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const receiver = new Receiver(server);
    holder.receiver = receiver;
    return receiver;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async waitFor(count: number, timeoutMs = 5000): Promise<Received[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.requests.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`receiver saw ${this.requests.length} of ${count} requests`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.requests;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export interface CreatedBot {
  bot: Bot;
  token: string;
  signingSecret: string;
}

export async function createBot(
  target: TestApp,
  ownerLogin: string,
  body: Record<string, unknown> = {},
): Promise<CreatedBot> {
  const res = await api(target, ownerLogin)('/api/bots', {
    method: 'POST',
    body: { name: 'Test Bot', ...body },
  });
  if (res.status !== 201)
    throw new Error(`create bot failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as CreatedBot;
}

export async function addBotToGuild(
  target: TestApp,
  ownerLogin: string,
  guildId: string,
  botId: string,
): Promise<void> {
  const res = await api(target, ownerLogin)(`/api/guilds/${guildId}/bots`, {
    method: 'POST',
    body: { botId },
  });
  if (res.status !== 204)
    throw new Error(`add bot failed: ${res.status} ${JSON.stringify(res.body)}`);
}

/** Calls the API with only a bot token: no proxy secret, no identity, no Origin. */
export function botApi(target: TestApp, token: string) {
  return async (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const res = await fetch(`${target.url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bot ${token}`,
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers) as Record<string, string>,
      body: (text ? JSON.parse(text) : null) as unknown,
    };
  };
}

/** Requests without any credentials, as an outside script or a webhook sender would make them. */
export async function bare(
  target: TestApp,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${target.url}${path}`, {
    method: init.method ?? 'POST',
    headers: {
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers) as Record<string, string>,
    body: (text ? JSON.parse(text) : null) as unknown,
  };
}
