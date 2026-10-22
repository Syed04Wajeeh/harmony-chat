import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyIp, parseCidr, parseIp, inCidr } from '../../src/outbound/ip.js';
import {
  EMPTY_ALLOWLIST,
  OutboundError,
  parseAllowlist,
  resolveTarget,
  type OutboundOptions,
} from '../../src/outbound/policy.js';
import { safeFetch } from '../../src/outbound/safe-fetch.js';

describe('IP classification', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['100.100.100.100', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.1', 'reserved'],
    ['192.0.2.7', 'documentation'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.1', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['febf::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001::1', 'reserved'],
    ['100::1', 'reserved'],
  ])('blocks %s as %s', (ip, reason) => {
    expect(classifyIp(ip)).toBe(reason);
  });

  it.each([
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.1.2.3',
    '::ffff:a01:203',
    '::ffff:169.254.169.254',
    '::ffff:100.64.0.1',
    '0:0:0:0:0:ffff:192.168.0.1',
    '[::ffff:127.0.0.1]',
    '64:ff9b::7f00:1',
    '64:ff9b::10.0.0.1',
    '2002:7f00:1::1',
    '2002:a00:1::',
    '::127.0.0.1',
    '::7f00:1',
  ])('blocks IPv4-embedding IPv6 form %s', (ip) => {
    expect(classifyIp(ip)).not.toBeNull();
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '100.63.255.255',
    '100.128.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.0.1.1',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.1',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2a00:1450:4001::1',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('allows public address %s', (ip) => {
    expect(classifyIp(ip)).toBeNull();
  });

  it.each([
    '2130706433',
    '0x7f000001',
    '0x7f.0.0.1',
    '0177.0.0.1',
    '127.1',
    '127.0.1',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '01.1.1.1',
    '',
    'localhost',
    'example.com',
    '1.1.1.1/8',
    ' 1.1.1.1',
    '1:2:3',
    ':::',
    'gggg::1',
  ])('refuses to treat non-canonical literal %j as public', (text) => {
    expect(classifyIp(text)).toBe('invalid');
  });

  it('parses IPv6 shorthand and embedded dotted quads', () => {
    expect(parseIp('::1')?.bytes).toEqual([...Array<number>(15).fill(0), 1]);
    expect(parseIp('::ffff:1.2.3.4')?.bytes.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(parseIp('1:2:3:4:5:6:7:8')?.bytes).toHaveLength(16);
    expect(parseIp('2001:db8::')?.bytes.slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
  });

  it('matches CIDR ranges on and off byte boundaries', () => {
    const net = parseCidr('100.64.0.0/10');
    expect(net && inCidr(parseIp('100.127.1.1')!, net)).toBe(true);
    expect(net && inCidr(parseIp('100.128.0.0')!, net)).toBe(false);
    const v6 = parseCidr('fc00::/7');
    expect(v6 && inCidr(parseIp('fdff::1')!, v6)).toBe(true);
    expect(v6 && inCidr(parseIp('fe00::1')!, v6)).toBe(false);
    expect(parseCidr('1.2.3.4/33')).toBeNull();
    expect(parseCidr('nonsense/8')).toBeNull();
    expect(parseCidr('1.2.3.4/x')).toBeNull();
  });
});

const publicResolve = () => Promise.resolve(['93.184.216.34']);
const base = (extra: Partial<OutboundOptions> = {}): OutboundOptions => ({
  ownerIsAdmin: false,
  allowlist: EMPTY_ALLOWLIST,
  resolve: publicResolve,
  ...extra,
});

describe('URL vetting', () => {
  it('accepts public http and https URLs and returns the resolved address', async () => {
    const target = await resolveTarget('https://hooks.example.com:8443/in?x=1', base());
    expect(target).toMatchObject({
      address: '93.184.216.34',
      family: 4,
      hostname: 'hooks.example.com',
    });
    await expect(resolveTarget('http://8.8.8.8/x', base())).resolves.toMatchObject({ family: 4 });
    await expect(resolveTarget('http://[2606:4700:4700::1111]/x', base())).resolves.toMatchObject({
      family: 6,
    });
  });

  it.each([
    'ftp://example.com/',
    'file:///etc/passwd',
    'gopher://example.com/',
    'javascript:alert(1)',
    'data:text/plain,hi',
    'not a url',
    '',
    'http://user:pass@example.com/',
    'http://user@example.com/',
  ])('rejects non-http(s) or credentialed URL %j', async (url) => {
    await expect(resolveTarget(url, base())).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it.each([
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://017700000001/',
    'http://0/',
    'http://0.0.0.0/',
    'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.1.1/',
    'http://172.17.0.1/',
    'http://192.168.0.10:8080/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[0:0:0:0:0:ffff:7f00:1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://224.0.0.1/',
  ])('blocks %s without any DNS lookup', async (url) => {
    const resolve = () => Promise.reject(new Error('must not resolve'));
    await expect(resolveTarget(url, base({ resolve }))).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it.each([
    'http://localhost/',
    'http://LOCALHOST/',
    'http://localhost./',
    'http://localhost:8080/',
    'http://foo.localhost/',
    'http://a.b.localhost./',
  ])('blocks localhost variant %s even if the resolver says otherwise', async (url) => {
    await expect(resolveTarget(url, base({ resolve: publicResolve }))).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it('blocks a hostname that resolves to a private address, including mixed answers', async () => {
    const privateOnly = base({ resolve: () => Promise.resolve(['10.1.2.3']) });
    await expect(resolveTarget('http://evil.example/', privateOnly)).rejects.toMatchObject({
      code: 'blocked_address',
    });
    const mixed = base({ resolve: () => Promise.resolve(['93.184.216.34', '127.0.0.1']) });
    await expect(resolveTarget('http://evil.example/', mixed)).rejects.toMatchObject({
      code: 'blocked_address',
    });
    const mapped = base({ resolve: () => Promise.resolve(['::ffff:127.0.0.1']) });
    await expect(resolveTarget('http://evil.example/', mapped)).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it('reports unresolvable hosts and slow DNS', async () => {
    const none = base({ resolve: () => Promise.resolve([]) });
    await expect(resolveTarget('http://nowhere.example/', none)).rejects.toMatchObject({
      code: 'unresolvable',
    });
    const failing = base({ resolve: () => Promise.reject(new Error('ENOTFOUND')) });
    await expect(resolveTarget('http://nowhere.example/', failing)).rejects.toMatchObject({
      code: 'unresolvable',
    });
    const slow = base({
      resolve: () => new Promise<string[]>(() => undefined),
      resolveTimeoutMs: 20,
    });
    await expect(resolveTarget('http://slow.example/', slow)).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('resolves exactly once per vetting', async () => {
    let calls = 0;
    const resolve = () => {
      calls += 1;
      return Promise.resolve(['93.184.216.34']);
    };
    await resolveTarget('http://once.example/', base({ resolve }));
    expect(calls).toBe(1);
  });
});

describe('private allowlist', () => {
  const allowlist = parseAllowlist(['10.0.0.0/8', 'bot.internal', '[::1]', '192.168.1.5']);

  it('parses hostnames, CIDRs and bare IPs', () => {
    expect([...allowlist.hosts]).toEqual(['bot.internal']);
    expect(allowlist.cidrs).toHaveLength(3);
  });

  it('is ignored for bots whose owner is not an admin', async () => {
    const options = base({ allowlist, ownerIsAdmin: false });
    await expect(resolveTarget('http://10.1.2.3/', options)).rejects.toBeInstanceOf(OutboundError);
    await expect(resolveTarget('http://192.168.1.5/', options)).rejects.toBeInstanceOf(
      OutboundError,
    );
  });

  it('lets an admin owner reach allowlisted CIDRs and IPs', async () => {
    const options = base({ allowlist, ownerIsAdmin: true });
    await expect(resolveTarget('http://10.1.2.3/', options)).resolves.toMatchObject({
      address: '10.1.2.3',
    });
    await expect(resolveTarget('http://192.168.1.5/', options)).resolves.toBeDefined();
    await expect(resolveTarget('http://[::1]/', options)).resolves.toBeDefined();
  });

  it('still blocks everything private that is not listed', async () => {
    const options = base({ allowlist, ownerIsAdmin: true });
    await expect(resolveTarget('http://192.168.1.6/', options)).rejects.toMatchObject({
      code: 'blocked_address',
    });
    await expect(resolveTarget('http://127.0.0.1/', options)).rejects.toMatchObject({
      code: 'blocked_address',
    });
    await expect(resolveTarget('http://169.254.169.254/', options)).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it('matches a hostname entry by name, and a hostname that resolves into a listed CIDR', async () => {
    const privateResolve = () => Promise.resolve(['172.18.0.9']);
    const byName = base({ allowlist, ownerIsAdmin: true, resolve: privateResolve });
    await expect(resolveTarget('http://bot.internal:9000/', byName)).resolves.toMatchObject({
      address: '172.18.0.9',
    });
    await expect(resolveTarget('http://other.internal/', byName)).rejects.toMatchObject({
      code: 'blocked_address',
    });
    const inRange = base({
      allowlist,
      ownerIsAdmin: true,
      resolve: () => Promise.resolve(['10.9.9.9']),
    });
    await expect(resolveTarget('http://anything.example/', inRange)).resolves.toBeDefined();
    const nonAdmin = base({ allowlist, ownerIsAdmin: false, resolve: privateResolve });
    await expect(resolveTarget('http://bot.internal/', nonAdmin)).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it('allows localhost by name only when it is listed', async () => {
    const listed = base({
      allowlist: parseAllowlist(['localhost']),
      ownerIsAdmin: true,
      resolve: () => Promise.resolve(['127.0.0.1']),
    });
    await expect(resolveTarget('http://localhost:3000/', listed)).resolves.toBeDefined();
    await expect(resolveTarget('http://sub.localhost/', listed)).rejects.toBeInstanceOf(
      OutboundError,
    );
  });
});

describe('safeFetch', () => {
  let server: Server;
  let port: number;
  const seen: { host: string | undefined; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push({ host: req.headers.host, body });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end();
        } else if (req.url === '/big') {
          res.writeHead(200).end('x'.repeat(200_000));
        } else if (req.url === '/slow') {
          setTimeout(() => res.writeHead(200).end('late'), 1000);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const allowed = (): OutboundOptions => ({
    ownerIsAdmin: true,
    allowlist: parseAllowlist(['127.0.0.1']),
  });

  it('refuses private targets before opening a socket', async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${port}/`, {
        timeoutMs: 1000,
        ownerIsAdmin: false,
        allowlist: EMPTY_ALLOWLIST,
      }),
    ).rejects.toMatchObject({ code: 'blocked_address' });
    expect(seen).toHaveLength(0);
  });

  it('posts to an allowlisted private target', async () => {
    const result = await safeFetch(`http://127.0.0.1:${port}/ok`, {
      ...allowed(),
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
      timeoutMs: 2000,
    });
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe('{"ok":true}');
    expect(seen.at(-1)?.body).toBe('{"a":1}');
  });

  it('does not follow redirects', async () => {
    const result = await safeFetch(`http://127.0.0.1:${port}/redirect`, {
      ...allowed(),
      timeoutMs: 2000,
    });
    expect(result.status).toBe(302);
  });

  it('caps the response body at 64 KiB', async () => {
    const result = await safeFetch(`http://127.0.0.1:${port}/big`, {
      ...allowed(),
      timeoutMs: 2000,
    });
    expect(result.body.length).toBe(64 * 1024);
    expect(result.truncated).toBe(true);
  });

  it('times out slow responses', async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${port}/slow`, { ...allowed(), timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('connects to the address it vetted, not to whatever the name resolves to later', async () => {
    // The name does not exist in DNS; the injected resolver supplies the one answer, and the
    // connection must go to it (a second lookup would fail with ENOTFOUND).
    const result = await safeFetch(`http://rebind.test:${port}/ok`, {
      ...allowed(),
      allowlist: parseAllowlist(['rebind.test']),
      resolve: () => Promise.resolve(['127.0.0.1']),
      timeoutMs: 2000,
    });
    expect(result.status).toBe(200);
    expect(seen.at(-1)?.host).toBe(`rebind.test:${port}`);
  });

  it('reports connection failures as network errors', async () => {
    await expect(
      safeFetch('http://127.0.0.1:1/', { ...allowed(), timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'network' });
  });
});
