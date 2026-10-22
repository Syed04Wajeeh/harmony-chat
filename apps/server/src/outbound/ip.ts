import { isIP } from 'node:net';

export interface ParsedIp {
  version: 4 | 6;
  bytes: number[];
}

/** Parses a canonical IPv4 or IPv6 literal. Anything else (decimal, octal, hex forms) is null. */
export function parseIp(input: string): ParsedIp | null {
  const text = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  const withoutZone = text.split('%')[0] ?? '';
  const version = isIP(withoutZone);
  if (version === 4) return { version: 4, bytes: withoutZone.split('.').map(Number) };
  if (version === 6) return { version: 6, bytes: parseV6(withoutZone) };
  return null;
}

function parseV6(text: string): number[] {
  let tail: number[] = [];
  let body = text;
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    tail = last.split('.').map(Number);
    body = text.slice(0, lastColon + 1) + '0:0';
  }
  const [head = '', rest] = body.split('::');
  const toGroups = (part: string) => (part === '' ? [] : part.split(':'));
  const headGroups = toGroups(head);
  const restGroups = rest === undefined ? [] : toGroups(rest);
  const missing = 8 - headGroups.length - restGroups.length;
  const groups =
    rest === undefined
      ? headGroups
      : [...headGroups, ...Array<string>(missing).fill('0'), ...restGroups];
  const bytes = groups.flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

export interface Cidr {
  version: 4 | 6;
  bytes: number[];
  bits: number;
}

export function parseCidr(text: string): Cidr | null {
  const [address = '', length] = text.split('/');
  const ip = parseIp(address);
  if (!ip) return null;
  const max = ip.version === 4 ? 32 : 128;
  const bits = length === undefined ? max : Number(length);
  if (
    !Number.isInteger(bits) ||
    bits < 0 ||
    bits > max ||
    (length !== undefined && !/^\d+$/.test(length))
  ) {
    return null;
  }
  return { version: ip.version, bytes: ip.bytes, bits };
}

export function inCidr(ip: ParsedIp, cidr: Cidr): boolean {
  if (ip.version !== cidr.version) return false;
  let remaining = cidr.bits;
  for (let i = 0; remaining > 0; i++, remaining -= 8) {
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
    if (((ip.bytes[i] ?? 0) & mask) !== ((cidr.bytes[i] ?? 0) & mask)) return false;
  }
  return true;
}

const cidrs = (list: Record<string, string>): [Cidr, string][] =>
  Object.entries(list).map(([text, reason]) => [parseCidr(text) as Cidr, reason]);

const BLOCKED_V4 = cidrs({
  '0.0.0.0/8': 'unspecified',
  '10.0.0.0/8': 'private',
  '100.64.0.0/10': 'cgnat',
  '127.0.0.0/8': 'loopback',
  '169.254.0.0/16': 'link-local',
  '172.16.0.0/12': 'private',
  '192.0.0.0/24': 'reserved',
  '192.0.2.0/24': 'documentation',
  '192.88.99.0/24': 'reserved',
  '192.168.0.0/16': 'private',
  '198.18.0.0/15': 'benchmarking',
  '198.51.100.0/24': 'documentation',
  '203.0.113.0/24': 'documentation',
  '224.0.0.0/4': 'multicast',
  '240.0.0.0/4': 'reserved',
});

/** IPv6 is allow-listed to global unicast (2000::/3) minus the special-purpose blocks below. */
const BLOCKED_V6 = cidrs({
  '2001::/23': 'reserved',
  '2001:db8::/32': 'documentation',
  '3fff::/20': 'documentation',
});
const GLOBAL_V6 = parseCidr('2000::/3') as Cidr;
const MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
const NAT64_PREFIX = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];

const REASON_V6_NOT_GLOBAL = (bytes: number[]): string => {
  if (bytes.every((b) => b === 0)) return 'unspecified';
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return 'loopback';
  const first = bytes[0] ?? 0;
  if ((first & 0xfe) === 0xfc) return 'unique-local';
  if (first === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return 'link-local';
  if (first === 0xff) return 'multicast';
  return 'reserved';
};

/** Returns why an address must not be contacted, or null when it is publicly routable. */
export function classifyIp(input: string): string | null {
  const ip = parseIp(input);
  if (!ip) return 'invalid';
  if (ip.version === 4) return classifyV4(ip.bytes);

  const { bytes } = ip;
  if (MAPPED_PREFIX.every((b, i) => bytes[i] === b)) return classifyV4(bytes.slice(12));
  if (NAT64_PREFIX.every((b, i) => bytes[i] === b)) {
    return classifyV4(bytes.slice(12)) ?? null;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    // 6to4 embeds the IPv4 address in bytes 2-5.
    return classifyV4(bytes.slice(2, 6)) ?? null;
  }
  if (!inCidr(ip, GLOBAL_V6)) return REASON_V6_NOT_GLOBAL(bytes);
  for (const [range, reason] of BLOCKED_V6) if (inCidr(ip, range)) return reason;
  return null;
}

function classifyV4(bytes: number[]): string | null {
  const ip: ParsedIp = { version: 4, bytes };
  for (const [range, reason] of BLOCKED_V4) if (inCidr(ip, range)) return reason;
  return null;
}
