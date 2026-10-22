import type { LookupFunction } from 'node:net';
import { Agent, request } from 'undici';
import { OutboundError, resolveTarget, type OutboundOptions } from './policy.js';

export const MAX_RESPONSE_BYTES = 64 * 1024;

export interface SafeFetchInit extends OutboundOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes?: number;
}

export interface SafeFetchResult {
  status: number;
  body: Buffer;
  /** True when the response was longer than the cap and was cut off. */
  truncated: boolean;
}

/**
 * The only way the server makes requests to addresses a user supplied. The host is resolved and
 * vetted once, then the socket is opened to that exact address (the Agent's `lookup` returns it),
 * so the name cannot resolve differently between check and connect. Redirects are never
 * followed, only http(s) is spoken, and the response body is capped.
 */
export async function safeFetch(rawUrl: string, init: SafeFetchInit): Promise<SafeFetchResult> {
  const deadline = Date.now() + init.timeoutMs;
  const target = await resolveTarget(rawUrl, init);
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
  const agent = new Agent({ connect: { lookup }, connections: 1 });
  const maxBytes = init.maxBytes ?? MAX_RESPONSE_BYTES;
  const remaining = Math.max(1, deadline - Date.now());

  try {
    const response = await request(target.url, {
      dispatcher: agent,
      method: (init.method ?? 'POST') as 'POST',
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(remaining),
      headersTimeout: remaining,
      bodyTimeout: remaining,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    for await (const chunk of response.body) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > maxBytes) {
        truncated = true;
        chunks.push(buffer.subarray(0, buffer.length - (size - maxBytes)));
        response.body.destroy();
        break;
      }
      chunks.push(buffer);
    }
    return { status: response.statusCode, body: Buffer.concat(chunks), truncated };
  } catch (error) {
    if (error instanceof OutboundError) throw error;
    const err = error as { name?: string; code?: string; cause?: { code?: string } };
    const code = err.code ?? err.cause?.code ?? '';
    if (err.name === 'TimeoutError' || code.includes('TIMEOUT') || err.name === 'AbortError') {
      throw new OutboundError('timeout', 'Request timed out');
    }
    throw new OutboundError('network', code || 'Request failed');
  } finally {
    await agent.destroy().catch(() => undefined);
  }
}
