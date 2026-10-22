import { invoke } from '@tauri-apps/api/core';

export type Call = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** What the native `connect_server` command can reject with. */
export type ConnectErrorCode =
  | 'empty'
  | 'malformed'
  | 'insecure'
  | 'credentials'
  | 'unreachable'
  | 'timeout'
  | 'bad_status'
  | 'not_harmony'
  | 'forbidden'
  | 'save_failed'
  | 'internal';

interface ConnectError {
  code: ConnectErrorCode;
  status?: number;
}

const FALLBACK = 'Something went wrong. Please try again.';

const MESSAGES: Record<ConnectErrorCode, string> = {
  empty: 'Enter the address of your Harmony server.',
  malformed: "That doesn't look like a web address.",
  insecure: 'Use an https:// address. Plain http is only allowed for localhost.',
  credentials: 'Remove the username and password from the address.',
  unreachable: "Can't reach the server — is Tailscale connected?",
  timeout: 'The server took too long to answer — is Tailscale connected?',
  bad_status: 'The server answered with an error.',
  not_harmony: "That address answered, but it doesn't look like a Harmony server.",
  forbidden: FALLBACK,
  save_failed: "Couldn't save the setting. Check that the app can write to its config folder.",
  internal: FALLBACK,
};

const isConnectError = (value: unknown): value is ConnectError =>
  typeof value === 'object' &&
  value !== null &&
  'code' in value &&
  typeof value.code === 'string' &&
  value.code in MESSAGES;

export function describeError(error: unknown): string {
  if (!isConnectError(error)) return FALLBACK;
  if (error.code === 'bad_status' && error.status !== undefined) {
    return `The server answered with an error (HTTP ${String(error.status)}).`;
  }
  return MESSAGES[error.code];
}

export type ConnectResult = { ok: true } | { ok: false; message: string };

/** Asks the native side to validate, probe and store the address, then open the server. */
export async function connect(url: string, call: Call = invoke): Promise<ConnectResult> {
  try {
    await call('connect_server', { url });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function storedServerUrl(call: Call = invoke): Promise<string> {
  try {
    return (await call<string | null>('get_server_url')) ?? '';
  } catch {
    return '';
  }
}
