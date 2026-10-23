import { invoke } from '@tauri-apps/api/core';
import type { Call } from './connect.js';

export type TailscaleState = 'not_installed' | 'not_running' | 'needs_login' | 'running';

export interface Account {
  id: string;
  tailnet: string;
  account: string;
  current: boolean;
}

export interface TailnetView {
  state: TailscaleState;
  account: string | null;
  tailnet: string | null;
  accounts: Account[];
}

export interface FoundServer {
  url: string;
  hostname: string;
  ownerLabel: string;
  /** True for every device that is not provably the user's own. */
  warn: boolean;
}

export interface KnownServer {
  url: string;
  name: string;
  lastUsed: number;
  ownerLabel: string | null;
}

const OFFLINE: TailnetView = { state: 'not_running', account: null, tailnet: null, accounts: [] };

export async function tailscaleStatus(call: Call = invoke): Promise<TailnetView> {
  try {
    return await call<TailnetView>('tailscale_status');
  } catch {
    return OFFLINE;
  }
}

/** Never throws: a failed scan is the same as finding nothing. */
export async function discoverServers(
  extraPort: number | null,
  call: Call = invoke,
): Promise<FoundServer[]> {
  try {
    return await call<FoundServer[]>('discover_servers', { extraPort });
  } catch {
    return [];
  }
}

export async function knownServers(call: Call = invoke): Promise<KnownServer[]> {
  try {
    return await call<KnownServer[]>('known_servers');
  } catch {
    return [];
  }
}

export async function forgetServer(url: string, call: Call = invoke): Promise<void> {
  await call('forget_server', { url });
}

export type SwitchResult = { ok: true } | { ok: false; message: string };

const SWITCH_HINT = 'You can also switch accounts from the Tailscale icon in the system tray.';

export async function switchAccount(id: string, call: Call = invoke): Promise<SwitchResult> {
  try {
    await call('tailscale_switch', { id });
    return { ok: true };
  } catch (error) {
    const reason =
      typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : '';
    return {
      ok: false,
      message: `${reason || 'Tailscale could not switch accounts.'} ${SWITCH_HINT}`,
    };
  }
}

/** The optional extra port typed next to the rescan button: empty is none, anything else must be 1 to 65535. */
export function parsePort(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d{1,5}$/.test(trimmed)) return 'invalid';
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : 'invalid';
}

export function tailnetMessage(view: TailnetView): string {
  switch (view.state) {
    case 'not_installed':
      return 'Tailscale is not installed on this device. Install it from tailscale.com, sign in, then rescan. You can still type an address below.';
    case 'not_running':
      return 'Tailscale is not running. Open Tailscale from the system tray or Start menu and turn it on, then rescan.';
    case 'needs_login':
      return 'Tailscale is signed out. Open Tailscale and sign in, then rescan.';
    case 'running':
      return view.account
        ? `Signed in to Tailscale as ${view.account}${view.tailnet && view.tailnet !== view.account ? ` (${view.tailnet})` : ''}.`
        : 'Connected to Tailscale.';
  }
}
