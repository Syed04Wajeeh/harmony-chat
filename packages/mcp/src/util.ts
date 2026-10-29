import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { explain } from './errors.js';

const PROGRESS_EVERY_MS = 15_000;

export function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

export function fail(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: explain(error) }] };
}

export type Extra = {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
};

/** Keeps the client from timing out a long wait: MCP clients reset on progress notifications. */
export function keepAlive(extra: Extra, label: string): () => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => undefined;
  const started = Date.now();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: ticks,
          message: `${label} (${Math.round((Date.now() - started) / 1000)}s)`,
        },
      })
      .catch(() => undefined);
  }, PROGRESS_EVERY_MS);
  return () => clearInterval(timer);
}
