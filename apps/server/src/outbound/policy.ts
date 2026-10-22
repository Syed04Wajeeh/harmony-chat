import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { classifyIp, inCidr, parseCidr, parseIp, type Cidr } from './ip.js';

export type OutboundErrorCode =
  'invalid_url' | 'blocked_address' | 'unresolvable' | 'timeout' | 'network';

export class OutboundError extends Error {
  constructor(
    readonly code: OutboundErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OutboundError';
  }
}

/** Private destinations an instance admin's bots may reach (OUTBOUND_PRIVATE_ALLOWLIST). */
export interface PrivateAllowlist {
  hosts: ReadonlySet<string>;
  cidrs: readonly Cidr[];
}

export const EMPTY_ALLOWLIST: PrivateAllowlist = { hosts: new Set(), cidrs: [] };

export function parseAllowlist(entries: readonly string[]): PrivateAllowlist {
  const hosts = new Set<string>();
  const cidrs: Cidr[] = [];
  for (const raw of entries) {
    const entry = normalizeHost(raw);
    const cidr = parseCidr(entry);
    if (cidr) cidrs.push(cidr);
    else if (entry) hosts.add(entry);
  }
  return { hosts, cidrs };
}

export interface OutboundOptions {
  /** True only for bots whose owner is an instance admin; others never reach private addresses. */
  ownerIsAdmin: boolean;
  allowlist: PrivateAllowlist;
  resolve?: (hostname: string) => Promise<string[]>;
  resolveTimeoutMs?: number;
}

export interface OutboundTarget {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  return value.endsWith('.') ? value.slice(0, -1) : value;
}

const isLocalhostName = (host: string) => host === 'localhost' || host.endsWith('.localhost');

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

/**
 * Parses and vets a URL, resolving its host exactly once. The returned address is the one to
 * connect to: connecting to it, instead of resolving again, is what defeats DNS rebinding.
 * The WHATWG URL parser already turns decimal, octal and hex IPv4 forms into dotted quads.
 */
export async function resolveTarget(
  rawUrl: string,
  options: OutboundOptions,
): Promise<OutboundTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundError('invalid_url', 'Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundError('invalid_url', 'Only http and https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new OutboundError('invalid_url', 'URLs must not contain credentials');
  }
  const hostname = normalizeHost(url.hostname);
  if (!hostname) throw new OutboundError('invalid_url', 'URL has no host');

  let addresses: string[];
  if (isIP(hostname.split('%')[0] ?? '')) {
    addresses = [hostname];
  } else if (isLocalhostName(hostname) && !options.allowlist.hosts.has(hostname)) {
    // Never trust the resolver to say "localhost" is loopback.
    throw new OutboundError('blocked_address', 'Target address is not allowed (loopback)');
  } else {
    addresses = await resolveWithTimeout(hostname, options);
  }
  if (addresses.length === 0) throw new OutboundError('unresolvable', 'Host did not resolve');

  const blocked = addresses.filter((address) => classifyIp(address) !== null);
  if (blocked.length > 0 && !isAllowlisted(hostname, blocked, options)) {
    const reason = classifyIp(blocked[0] ?? '') ?? 'blocked';
    throw new OutboundError('blocked_address', `Target address is not allowed (${reason})`);
  }
  const address = addresses[0] ?? '';
  return { url, hostname, address, family: parseIp(address)?.version ?? 4 };
}

function isAllowlisted(host: string, blocked: string[], options: OutboundOptions): boolean {
  if (!options.ownerIsAdmin) return false;
  if (options.allowlist.hosts.has(host)) return true;
  return blocked.every((address) => {
    const ip = parseIp(address);
    return ip !== null && options.allowlist.cidrs.some((cidr) => inCidr(ip, cidr));
  });
}

async function resolveWithTimeout(hostname: string, options: OutboundOptions): Promise<string[]> {
  const resolve = options.resolve ?? defaultResolve;
  const timeoutMs = options.resolveTimeoutMs ?? 3000;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      resolve(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new OutboundError('timeout', 'DNS lookup timed out')),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof OutboundError) throw error;
    throw new OutboundError('unresolvable', 'Host did not resolve');
  } finally {
    clearTimeout(timer);
  }
}
