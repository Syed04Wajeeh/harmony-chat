import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonPaths, requireToken, type DaemonPaths } from './agentd-config.js';

// The hook's side of the daemon protocol. One request and one answer per connection, as lines of
// JSON on a unix socket (mode 600, in a mode-700 directory). Imports are node built-ins only:
// every tool call of a Claude Code session starts a process that loads this file.

export interface AgentdRequest {
  v: 1;
  op: 'event' | 'ping' | 'status' | 'shutdown';
  event?: Record<string, unknown>;
}

export interface AgentdReply {
  ok?: boolean;
  /** The daemon will take a while (an approval, a pause) and says for how long at most. */
  ack?: boolean;
  waitMs?: number;
  /** The text the hook prints on stdout, if any. */
  output?: string;
  error?: string;
  status?: unknown;
}

const STRING_LIMIT = 1500;
const TOP_LEVEL = [
  'session_id',
  'hook_event_name',
  'cwd',
  'agent_id',
  'agent_type',
  'tool_name',
  'tool_use_id',
  'message',
  'notification_type',
  'stop_hook_active',
  'model',
  'source',
  'reason',
] as const;
// Only inputs that name where the agent works; contents of files and edits are never sent.
const TOOL_INPUT = [
  'command',
  'description',
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'url',
  'query',
  'subagent_type',
] as const;

const clipString = (value: string, max: number) =>
  value.length <= max ? value : value.slice(0, max);

/**
 * What the daemon is sent for one hook event: a whitelist, with long strings cut. The prompt and
 * the final reply are clipped hard because they are the fields most likely to carry secrets.
 */
export function trimEvent(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TOP_LEVEL) {
    const value = raw[key];
    if (typeof value === 'string') out[key] = clipString(value, STRING_LIMIT);
    else if (typeof value === 'boolean') out[key] = value;
  }
  if (typeof raw.prompt === 'string') out.prompt = clipString(raw.prompt, 300);
  if (typeof raw.last_assistant_message === 'string') {
    out.last_assistant_message = clipString(raw.last_assistant_message, 1200);
  }
  const response = raw.tool_response;
  if (response && typeof response === 'object') {
    const agentId = (response as Record<string, unknown>).agentId;
    if (typeof agentId === 'string') out.tool_agent_id = clipString(agentId, 100);
  }
  const input = raw.tool_input;
  if (input && typeof input === 'object') {
    const kept: Record<string, unknown> = {};
    for (const key of TOOL_INPUT) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === 'string') kept[key] = clipString(value, STRING_LIMIT);
    }
    out.tool_input = kept;
  }
  return out;
}

export const requestFor = (raw: Record<string, unknown>): AgentdRequest => ({
  v: 1,
  op: 'event',
  event: trimEvent(raw),
});

export interface CallResult {
  reply?: AgentdReply;
  /** The daemon said it would wait and then went away before answering. */
  lostAfterAck: boolean;
  /** Why there is no reply: nothing listening, too slow, or garbage. */
  failure?: 'unreachable' | 'timeout' | 'protocol';
}

export interface CallOptions {
  connectMs?: number;
  /** How long the first line may take. A daemon that blocks (approval, pause) acks at once. */
  ackMs?: number;
  /** Slack on top of the wait the daemon announced. */
  extraWaitMs?: number;
}

/** Sends one request. Never throws and never waits longer than the announced wait plus slack. */
export function callDaemon(
  socketPath: string,
  request: AgentdRequest,
  options: CallOptions = {},
): Promise<CallResult> {
  const connectMs = options.connectMs ?? 400;
  const ackMs = options.ackMs ?? 1500;
  const extraWaitMs = options.extraWaitMs ?? 3000;
  return new Promise((resolve) => {
    let done = false;
    let acked = false;
    let buffer = '';
    let timer: NodeJS.Timeout | undefined;
    const socket = net.createConnection(socketPath);
    const finish = (result: CallResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ lostAfterAck: acked, failure: 'timeout' }), ms);
    };
    arm(connectMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      arm(ackMs);
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let reply: AgentdReply;
        try {
          reply = JSON.parse(line) as AgentdReply;
        } catch {
          return finish({ lostAfterAck: acked, failure: 'protocol' });
        }
        if (reply.ack) {
          acked = true;
          arm((reply.waitMs ?? 0) + extraWaitMs);
          continue;
        }
        return finish({ reply, lostAfterAck: false });
      }
    });
    socket.on('error', () => finish({ lostAfterAck: acked, failure: 'unreachable' }));
    socket.on('close', () => finish({ lostAfterAck: acked, failure: 'unreachable' }));
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function answers(socketPath: string): Promise<boolean> {
  const { reply } = await callDaemon(
    socketPath,
    { v: 1, op: 'ping' },
    { connectMs: 300, ackMs: 800 },
  );
  return reply?.ok === true;
}

/** Starts `agentd-bin.js` detached, with its output in the log file next to the socket. */
export function spawnDaemon(paths: DaemonPaths, env: Record<string, string | undefined>): void {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agentd-bin.js');
  const log = openSync(paths.log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ['ignore', log, log],
      env,
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

export interface EnsureOptions {
  /** How the daemon is started; tests pass their own. */
  start?: () => void;
  /** How long one hook waits for a freshly started daemon to answer. */
  startWaitMs?: number;
  /** After a failed start, hooks leave the daemon alone this long. */
  retryAfterMs?: number;
  staleLockMs?: number;
}

/**
 * Makes sure a daemon answers on the socket, starting one if needed. Several hooks may ask at
 * once (the first events of a session arrive together): a lock directory lets exactly one of
 * them start the daemon while the rest wait for the socket, and the daemon refuses to run twice
 * on its own as well (see `agentd.ts`).
 */
export async function ensureDaemon(
  paths: DaemonPaths,
  env: Record<string, string | undefined>,
  options: EnsureOptions = {},
): Promise<boolean> {
  if (await answers(paths.socket)) return true;
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  // A daemon that would not start (bad config, no permission) is not retried on every tool call.
  try {
    if (Date.now() - statSync(paths.failed).mtimeMs < (options.retryAfterMs ?? 60_000))
      return false;
  } catch {
    // no marker
  }
  const deadline = Date.now() + (options.startWaitMs ?? 2500);
  while (Date.now() < deadline) {
    let held = false;
    try {
      mkdirSync(paths.lock, { mode: 0o700 });
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(paths.lock).mtimeMs > (options.staleLockMs ?? 15_000)) {
          rmSync(paths.lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
    }
    if (held) {
      let up = true;
      try {
        // Another hook may have finished starting it while this one took the lock.
        if (!(await answers(paths.socket))) {
          (options.start ?? (() => spawnDaemon(paths, env)))();
          // The lock is held until the socket answers, so late arrivals wait instead of starting a second.
          up = false;
          while (Date.now() < deadline && !(up = await answers(paths.socket))) await sleep(30);
        }
      } finally {
        rmSync(paths.lock, { recursive: true, force: true });
      }
      if (!up) writeFileSync(paths.failed, String(Date.now()), { mode: 0o600 });
      return up;
    }
    if (await answers(paths.socket)) return true;
    await sleep(30);
  }
  return false;
}

export interface ViaDaemon {
  /** The daemon dealt with the event: print `stdout` (if any) and stop. */
  handled: boolean;
  stdout?: string;
  log?: string;
}

/**
 * The hook's fast path. Returns `handled: false` when the daemon cannot be used, and the caller
 * then does what `harmony-hook` always did (direct approvals and notes), so a missing daemon never
 * hangs or blocks Claude Code.
 */
export async function viaDaemon(
  rawInput: string,
  env: Record<string, string | undefined>,
  options: { start?: () => void; startWaitMs?: number } = {},
): Promise<ViaDaemon> {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawInput);
    if (!parsed || typeof parsed !== 'object') return { handled: false };
    raw = parsed as Record<string, unknown>;
  } catch {
    return { handled: false };
  }
  let paths: DaemonPaths;
  try {
    paths = daemonPaths(env, requireToken(env));
  } catch {
    return { handled: false };
  }
  const request = requestFor(raw);
  let result = await callDaemon(paths.socket, request);
  if (!result.reply && !result.lostAfterAck && result.failure === 'unreachable') {
    const up = await ensureDaemon(paths, env, {
      ...(options.start && { start: options.start }),
      ...(options.startWaitMs !== undefined && { startWaitMs: options.startWaitMs }),
    });
    if (up) result = await callDaemon(paths.socket, request);
  }
  if (result.reply?.ok) {
    return { handled: true, ...(result.reply.output && { stdout: result.reply.output }) };
  }
  if (result.lostAfterAck && raw.hook_event_name === 'PreToolUse') {
    // The daemon was holding this call (an approval, a pause) and vanished: Claude Code's own prompt.
    return {
      handled: true,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason:
            'The Harmony agent daemon went away while this call was waiting; asking in the terminal.',
        },
      }),
      log: 'harmony-hook: the daemon went away mid-wait',
    };
  }
  return {
    handled: false,
    log: `harmony-hook: daemon unavailable (${result.failure ?? result.reply?.error ?? 'error'}); using direct mode`,
  };
}
