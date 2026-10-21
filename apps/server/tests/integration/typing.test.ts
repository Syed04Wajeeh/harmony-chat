import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TestSocket,
  createChannel,
  createInfra,
  ensureUser,
  settle,
  type Infra,
  type TestApp,
} from './support/harness.js';

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

describe('typing indicators and frame limits', () => {
  let infra: Infra;
  let a: TestApp;
  let b: TestApp;
  const sockets: TestSocket[] = [];

  const connect = async (app: TestApp, login: string) => {
    const socket = await TestSocket.connect(app, login);
    sockets.push(socket);
    await socket.waitFor('hello');
    return socket;
  };

  beforeAll(async () => {
    infra = createInfra();
    [a, b] = await Promise.all([infra.startApp(), infra.startApp()]);
  });

  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  it('relays typing to subscribers on other instances without storing it', async () => {
    const [typist, watcher] = [unique('typist'), unique('watcher')];
    const channelId = await createChannel(infra.db, [typist, watcher]);
    const typistId = await ensureUser(infra.db, typist);
    const sender = await connect(a, typist);
    const receiver = await connect(b, watcher);
    await receiver.subscribe(channelId);

    sender.send({ type: 'typing', channelId });
    const [event] = await receiver.waitFor('typing');
    expect(event).toEqual({ type: 'typing', channelId, userId: typistId });
    const stored = await infra.db
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', channelId)
      .execute();
    expect(stored).toHaveLength(0);
  });

  it('ignores more than one typing ping per user and channel every 2 seconds', async () => {
    const [typist, watcher] = [unique('typist'), unique('watcher')];
    const channelId = await createChannel(infra.db, [typist, watcher]);
    const sender = await connect(a, typist);
    const second = await connect(b, typist);
    const receiver = await connect(a, watcher);
    await receiver.subscribe(channelId);

    for (let i = 0; i < 5; i++) sender.send({ type: 'typing', channelId });
    second.send({ type: 'typing', channelId });
    await receiver.waitFor('typing');
    await settle(300);
    expect(receiver.of('typing')).toHaveLength(1);
    expect(sender.of('error')).toHaveLength(0);

    await settle(2000);
    sender.send({ type: 'typing', channelId });
    await receiver.waitFor('typing', 2);
  });

  it('does not relay typing for a channel the sender is not in', async () => {
    const [member, outsider] = [unique('member'), unique('outsider')];
    const channelId = await createChannel(infra.db, [member]);
    const watcher = await connect(a, member);
    await watcher.subscribe(channelId);
    const sneaky = await connect(b, outsider);

    sneaky.send({ type: 'typing', channelId });
    expect((await sneaky.waitFor('error'))[0]?.code).toBe('forbidden');
    await settle(200);
    expect(watcher.of('typing')).toHaveLength(0);
  });

  it('rate limits frames per connection with a token bucket and closes persistent flooders', async () => {
    const strict = await infra.startApp({ WS_FRAME_BURST: '5', WS_FRAME_REFILL_PER_SECOND: '1' });
    const user = unique('flooder');
    const channelId = await createChannel(infra.db, [user]);
    const socket = await connect(strict, user);

    for (let i = 0; i < 20; i++) socket.send({ type: 'typing', channelId });
    await socket.waitFor('error', 15);
    expect(socket.of('error').every((e) => e.code === 'rate_limited')).toBe(true);
    expect(socket.socket.readyState).toBe(socket.socket.OPEN);

    const closed = new Promise<number>((resolve) => socket.socket.once('close', resolve));
    for (let i = 0; i < 200; i++) socket.send({ type: 'typing', channelId });
    expect(await closed).toBe(1008);
  });

  it('lets a normal client burst within the default budget', async () => {
    const user = unique('burst');
    const channelId = await createChannel(infra.db, [user]);
    const socket = await connect(a, user);
    for (let i = 0; i < 25; i++) socket.send({ type: 'unsubscribe', channelId });
    await socket.subscribe(channelId);
    expect(socket.of('error')).toHaveLength(0);
  });
});
