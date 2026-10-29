import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gateway, HarmonyApi, type InteractionContext } from '../../src/harmony.ts';
import { PermissionChecker } from '../../src/permissions.ts';
import { json, recordingFetch, TOKEN } from './helpers.ts';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: { type: string; [k: string]: unknown }[] = [];
  private listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  readonly url: string;
  readonly options: { headers: Record<string, string> };
  constructor(url: string, options: { headers: Record<string, string> }) {
    this.url = url;
    this.options = options;
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as FakeSocket['sent'][number]);
  }
  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
  emit(type: string, event: { data?: string }) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  receive(frame: unknown) {
    this.emit('message', { data: JSON.stringify(frame) });
  }
}

const interaction = (id: string) => ({
  id,
  token: `tok-${id}`,
  type: 'command',
  command: { name: 'status', options: {} },
  guildId: '1',
  channelId: '2',
  user: { id: '3', login: 'a', displayName: 'A' },
  createdAt: '',
  expiresAt: '',
});

describe('gateway client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (
    onInteraction: (c: InteractionContext) => Promise<void>,
    extra: Partial<ConstructorParameters<typeof Gateway>[0]> = {},
  ) => {
    const logs: string[] = [];
    const followups = recordingFetch(() => json(201, {}));
    const gateway = new Gateway({
      url: 'http://ingress:8081',
      token: TOKEN,
      log: (l) => logs.push(l),
      api: new HarmonyApi('http://ingress:8081', TOKEN, followups),
      onInteraction,
      WebSocketImpl: FakeSocket as never,
      keepaliveSeconds: 0,
      ...extra,
    });
    gateway.start();
    return { gateway, logs, followups };
  };

  it('connects with the bot header, resumes after hello, and answers interactions', async () => {
    const { gateway } = make((c) => c.say('hi'));
    const ws = FakeSocket.all[0] as FakeSocket;
    expect(ws.url).toBe('ws://ingress:8081/api/ws');
    expect(ws.options.headers).toEqual({ authorization: `Bot ${TOKEN}` });
    ws.receive({ type: 'hello' });
    expect(ws.sent).toEqual([{ type: 'resume', lastSeq: 0 }]);
    ws.receive({ type: 'interaction.create', interaction: interaction('7') });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sent[1]).toEqual({
      type: 'interaction.respond',
      interactionId: '7',
      token: 'tok-7',
      response: { type: 'message', content: 'hi', ephemeral: true },
    });
    gateway.stop();
  });

  it('answers deferred by itself when the handler is slow, then follows up through REST', async () => {
    let finish: () => void = () => undefined;
    const { gateway, followups } = make(
      (c) =>
        new Promise<void>((resolve) => {
          finish = () => void c.say('late').then(resolve);
        }),
    );
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.receive({ type: 'hello' });
    ws.receive({ type: 'interaction.create', interaction: interaction('8') });
    await vi.advanceTimersByTimeAsync(2300);
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'interaction.respond',
      response: { type: 'deferred' },
    });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(followups.calls[0]).toMatchObject({
      method: 'POST',
      body: { content: 'late', ephemeral: true },
    });
    expect(followups.calls[0]?.url).toBe('http://ingress:8081/api/interactions/8/tok-8/followup');
    expect(followups.calls[0]?.headers['authorization']).toBeUndefined(); // the interaction token is the credential
    gateway.stop();
  });

  it('survives a handler that throws and ignores a repeated interaction id', async () => {
    let runs = 0;
    const { gateway, logs } = make(() => {
      runs++;
      return Promise.reject(new Error('boom'));
    });
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.receive({ type: 'hello' });
    ws.receive({ type: 'interaction.create', interaction: interaction('9') });
    ws.receive({ type: 'interaction.create', interaction: interaction('9') });
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    expect(logs.some((l) => l.includes('failed: boom'))).toBe(true);
    expect(ws.sent.at(-1)).toMatchObject({
      response: {
        type: 'message',
        content: 'Something went wrong; the details are in the bot log.',
      },
    });
    gateway.stop();
  });

  it('reconnects with a growing delay and resets it after hello', async () => {
    const { gateway } = make(() => Promise.resolve());
    FakeSocket.all[0]?.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]?.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2]?.receive({ type: 'hello' });
    FakeSocket.all[2]?.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(4);
    gateway.stop();
    FakeSocket.all[3]?.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(4); // stop() means stay stopped
  });

  it('keeps the last event number, acknowledges, and resumes from it after a restart', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hb-seq-')), 'seq');
    writeFileSync(file, '5');
    const first = make(() => Promise.resolve(), { seqFile: file });
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.receive({ type: 'hello' });
    expect(ws.sent[0]).toEqual({ type: 'resume', lastSeq: 5 });
    ws.receive({ type: 'event', seq: 6, event: {} });
    ws.receive({ type: 'event', seq: 4, event: {} }); // a repeat
    expect(ws.sent.filter((f) => f.type === 'event.ack')).toEqual([
      { type: 'event.ack', seq: 6 },
      { type: 'event.ack', seq: 4 },
    ]);
    expect(readFileSync(file, 'utf8')).toBe('6');
    first.gateway.stop();
  });

  it('drops a silent connection when the keepalive probe goes unanswered', async () => {
    const { gateway, logs } = make(() => Promise.resolve(), { keepaliveSeconds: 10 });
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.receive({ type: 'hello' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.sent.filter((f) => f.type === 'resume')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(logs.some((l) => l.includes('went silent'))).toBe(true);
    expect(ws.readyState).toBe(3);
    gateway.stop();
  });

  it('turns the probe off when the bot has no events scope', async () => {
    const { gateway } = make(() => Promise.resolve(), { keepaliveSeconds: 10 });
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.receive({ type: 'hello' });
    ws.receive({ type: 'error', code: 'missing_scope', message: '' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.sent.filter((f) => f.type === 'resume')).toHaveLength(1);
    expect(ws.readyState).toBe(1);
    gateway.stop();
  });
});

describe('permission checker', () => {
  const api = (members: { id: string; roleIds: string[] }[], ownerId = '99') =>
    new HarmonyApi(
      'http://h',
      TOKEN,
      recordingFetch((call) => {
        if (call.url.endsWith('/api/guilds')) return json(200, { guilds: [{ id: '1', ownerId }] });
        if (call.url.endsWith('/roles')) {
          return json(200, {
            roles: [
              { id: '1', isDefault: true, permissions: ['view_channel'] },
              { id: '5', isDefault: false, permissions: ['manage_guild'] },
              { id: '6', isDefault: false, permissions: ['administrator'] },
            ],
          });
        }
        return json(200, { members });
      }),
    );

  it('grants by role, by administrator and to the owner; refuses everyone else and failures', async () => {
    const checker = new PermissionChecker(
      api([
        { id: '1', roleIds: ['5'] },
        { id: '2', roleIds: ['6'] },
        { id: '3', roleIds: [] },
        { id: '99', roleIds: [] },
      ]),
      '1',
    );
    expect(await checker.has('1', 'manage_guild')).toBe(true);
    expect(await checker.has('1', 'manage_roles')).toBe(false);
    expect(await checker.has('2', 'manage_roles')).toBe(true);
    expect(await checker.has('3', 'manage_guild')).toBe(false);
    expect(await checker.has('99', 'manage_guild')).toBe(true);
    expect(await checker.has('404', 'manage_guild')).toBe(false);
    const broken = new PermissionChecker(
      new HarmonyApi(
        'http://h',
        TOKEN,
        recordingFetch(() => json(500)),
      ),
      '1',
    );
    expect(await broken.has('1', 'manage_guild')).toBe(false);
  });

  it('refreshes after the cache time so a revoked role stops working', async () => {
    let now = 0;
    const members = [{ id: '1', roleIds: ['5'] }];
    const checker = new PermissionChecker(api(members), '1', 10_000, () => now);
    expect(await checker.has('1', 'manage_guild')).toBe(true);
    members[0] = { id: '1', roleIds: [] };
    expect(await checker.has('1', 'manage_guild')).toBe(true); // cached
    now = 11_000;
    expect(await checker.has('1', 'manage_guild')).toBe(false);
  });
});
