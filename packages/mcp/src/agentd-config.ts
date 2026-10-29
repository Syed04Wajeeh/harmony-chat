import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError } from './config.js';

// Settings shared by the hook and the daemon. This file stays light on purpose (no zod, no
// WebSocket): the hook loads it on every tool call and has tens of milliseconds to spare.

const TOKEN_SHAPE = /^hb_\d+_\S+$/;

/**
 * The bot token: `HARMONY_BOT_TOKEN`, or the file named by `HARMONY_BOT_TOKEN_FILE`. The file
 * holds either the bare token or `HARMONY_BOT_TOKEN=...` lines (an env file). It must not be
 * readable by group or others, so the token never has to sit in a settings.json.
 */
export function resolveToken(env: Record<string, string | undefined>): string | undefined {
  const direct = env.HARMONY_BOT_TOKEN?.trim();
  if (direct) return direct;
  const file = env.HARMONY_BOT_TOKEN_FILE?.trim();
  if (!file) return undefined;
  let mode: number;
  let text: string;
  try {
    mode = statSync(file).mode;
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError('HARMONY_BOT_TOKEN_FILE cannot be read.');
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new ConfigError('HARMONY_BOT_TOKEN_FILE must be readable by you only (chmod 600).');
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?HARMONY_BOT_TOKEN\s*=\s*["']?([^"'\s]+)["']?$/.exec(line);
    if (match?.[1]) return match[1];
    if (TOKEN_SHAPE.test(line)) return line;
  }
  throw new ConfigError('HARMONY_BOT_TOKEN_FILE holds no bot token.');
}

export function requireToken(env: Record<string, string | undefined>): string {
  const token = resolveToken(env);
  if (!token || !TOKEN_SHAPE.test(token)) {
    throw new ConfigError(
      'Set HARMONY_BOT_TOKEN or HARMONY_BOT_TOKEN_FILE to a Harmony bot token (hb_<botId>_<secret>).',
    );
  }
  return token;
}

export const agentdEnabled = (env: Record<string, string | undefined>): boolean =>
  env.HARMONY_AGENTD === '1';

export const baseUrl = (env: Record<string, string | undefined>): string =>
  (env.HARMONY_URL?.trim() || 'http://127.0.0.1:8471').replace(/\/+$/, '');

export interface DaemonPaths {
  dir: string;
  socket: string;
  pid: string;
  lock: string;
  /** Touched when starting the daemon failed, so hooks do not retry on every tool call. */
  failed: string;
  log: string;
}

/** One daemon per user and bot: its files are named after a hash of the URL and the token. */
export function daemonPaths(env: Record<string, string | undefined>, token: string): DaemonPaths {
  const xdg = env.XDG_RUNTIME_DIR?.trim();
  const root =
    env.HARMONY_AGENTD_DIR?.trim() ||
    (xdg ? path.join(xdg, 'harmony-agentd') : path.join(os.homedir(), '.cache', 'harmony-agentd'));
  const key = createHash('sha256')
    .update(`${baseUrl(env)}\n${token}`)
    .digest('hex')
    .slice(0, 12);
  return {
    dir: root,
    socket: path.join(root, `${key}.sock`),
    pid: path.join(root, `${key}.pid`),
    lock: path.join(root, `${key}.lock`),
    failed: path.join(root, `${key}.failed`),
    log: path.join(root, `${key}.log`),
  };
}

export interface ApprovalSettings {
  approvalPattern: RegExp | undefined;
  approvalSeconds: number;
  onTimeout: 'deny' | 'ask';
  risk: 'low' | 'medium' | 'high';
  permission: string;
}

export const intFrom = (
  raw: string | undefined,
  fallback: number,
  name: string,
  min = 1,
): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${name} must be an integer of at least ${String(min)}.`);
  }
  return value;
};

export function parseApprovalSettings(env: Record<string, string | undefined>): ApprovalSettings {
  let approvalPattern: RegExp | undefined;
  const rawPattern = env.HARMONY_APPROVAL_PATTERN;
  if (rawPattern && rawPattern.trim() !== '') {
    try {
      approvalPattern = new RegExp(rawPattern);
    } catch {
      throw new ConfigError('HARMONY_APPROVAL_PATTERN is not a valid regular expression.');
    }
  }
  const approvalSeconds = intFrom(
    env.HARMONY_APPROVAL_TIMEOUT_SECONDS,
    300,
    'HARMONY_APPROVAL_TIMEOUT_SECONDS',
  );
  if (approvalSeconds > 3600) {
    throw new ConfigError('HARMONY_APPROVAL_TIMEOUT_SECONDS is at most 3600.');
  }
  const onTimeout = env.HARMONY_APPROVAL_ON_TIMEOUT?.trim() || 'deny';
  if (onTimeout !== 'deny' && onTimeout !== 'ask') {
    throw new ConfigError('HARMONY_APPROVAL_ON_TIMEOUT must be "deny" or "ask".');
  }
  const risk = env.HARMONY_APPROVAL_RISK?.trim() || 'medium';
  if (risk !== 'low' && risk !== 'medium' && risk !== 'high') {
    throw new ConfigError('HARMONY_APPROVAL_RISK must be low, medium or high.');
  }
  return {
    approvalPattern,
    approvalSeconds,
    onTimeout,
    risk,
    permission: env.HARMONY_APPROVAL_PERMISSION?.trim() || 'manage_messages',
  };
}
