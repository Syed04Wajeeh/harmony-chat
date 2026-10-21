import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TestSocket,
  createChannel,
  createInfra,
  settle,
  type Infra,
  type TestApp,
} from './support/harness.js';

describe('realtime delivery', () => {
  let infra: Infra;
  let target: TestApp;
  let channelId: string;
  const sockets: TestSocket[] = [];

  const connect = async (login: string, app = target) => {
    const socket = await TestSocket.connect(app, login);
    sockets.push(socket);
    return socket;
  };
  const send = (socket: TestSocket, content: string, nonce: string) =>
    socket.send({ type: 'message.send', channelId, content, nonce });

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ MESSAGE_RATE_MAX: '1000' });
  });

  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  it('greets with hello carrying the user and instance id', async () => {
    const socket = await connect('hello@example.com');
    const [hello] = await socket.waitFor('hello');
    expect(hello).toMatchObject({
      user: { login: 'hello@example.com' },
      instanceId: target.config.INSTANCE_ID,
    });
  });

  it('delivers each message once to every subscriber and acks the sender', async () => {
    channelId = await createChannel(infra.db);
    const alice = await connect('alice@example.com');
    const bob = await connect('bob@example.com');
    await alice.subscribe(channelId);
    await bob.subscribe(channelId);

    send(alice, 'hello bob', 'nonce-1');
    const [ack] = await alice.waitFor('ack');
    const [received] = await bob.waitFor('message.created');
    await settle();

    expect(ack).toMatchObject({ nonce: 'nonce-1', message: { content: 'hello bob' } });
    expect(received?.message).toEqual(ack?.message);
    expect(bob.of('message.created')).toHaveLength(1);
    expect(alice.of('ack')).toHaveLength(1);
    // The sender also sees its own message on the broadcast path; clients dedupe by id.
    expect(alice.of('message.created').map((f) => f.message.id)).toEqual([ack?.message.id]);
  });

  it('does not deliver messages from channels a socket is not subscribed to', async () => {
    const other = await createChannel(infra.db);
    const listener = await connect('listener@example.com');
    const sender = await connect('sender@example.com');
    await listener.subscribe(other);
    sender.send({ type: 'message.send', channelId, content: 'elsewhere', nonce: 'x' });
    await sender.waitFor('ack');
    await settle();
    expect(listener.of('message.created')).toHaveLength(0);
  });

  it('stops delivery after unsubscribe', async () => {
    const sub = await connect('unsub@example.com');
    const sender = await connect('unsub-sender@example.com');
    await sub.subscribe(channelId);
    sub.send({ type: 'unsubscribe', channelId });
    await settle();
    send(sender, 'after unsubscribe', 'u1');
    await sender.waitFor('ack');
    await settle();
    expect(sub.of('message.created')).toHaveLength(0);
  });

  it('REST posts reach WebSocket subscribers', async () => {
    const sub = await connect('rest-sub@example.com');
    await sub.subscribe(channelId);
    const { api } = await import('./support/harness.js');
    await api(target, 'rest-poster@example.com')(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content: 'via rest' },
    });
    const [frame] = await sub.waitFor('message.created');
    expect(frame?.message.content).toBe('via rest');
  });

  it('backfills exactly the missed messages, in order, after a reconnect', async () => {
    const channel = await createChannel(infra.db);
    const reader = await connect('reader@example.com');
    const writer = await connect('writer@example.com');
    await reader.subscribe(channel);
    await writer.subscribe(channel);

    writer.send({ type: 'message.send', channelId: channel, content: 'seen', nonce: 's0' });
    const [seen] = await reader.waitFor('message.created');
    await reader.close();

    for (let i = 1; i <= 3; i++) {
      writer.send({
        type: 'message.send',
        channelId: channel,
        content: `missed ${i}`,
        nonce: `s${i}`,
      });
    }
    await writer.waitFor('ack', 4);

    const returning = await connect('reader@example.com');
    await returning.subscribe(channel, seen?.message.id);
    const [backfill] = returning.of('backfill');
    expect(backfill?.messages.map((m) => m.content)).toEqual(['missed 1', 'missed 2', 'missed 3']);
    expect(backfill?.hasMore).toBe(false);
  });

  it('reports hasMore when the backfill exceeds the limit', async () => {
    const channel = await createChannel(infra.db);
    const author = await infra.db
      .selectFrom('users')
      .select('id')
      .where('login', '=', 'writer@example.com')
      .executeTakeFirstOrThrow();
    await sql`
      insert into messages (channel_id, author_id, content)
      select ${channel}, ${author.id}, 'bulk' from generate_series(1, 205)
    `.execute(infra.db);

    const socket = await connect('bulk@example.com');
    await socket.subscribe(channel, '0');
    const [backfill] = socket.of('backfill');
    expect(backfill?.messages).toHaveLength(200);
    expect(backfill?.hasMore).toBe(true);
  });

  it('answers malformed frames with an error and keeps the socket open', async () => {
    const socket = await connect('malformed@example.com');
    socket.send('not json');
    socket.send({ type: 'explode' });
    socket.send({ type: 'message.send', channelId, content: '', nonce: 'n' });
    const errors = await socket.waitFor('error', 3);
    expect(errors.every((e) => e.code === 'invalid_frame')).toBe(true);

    await socket.subscribe(channelId);
    expect(socket.socket.readyState).toBe(socket.socket.OPEN);
  });

  it('errors on subscribing to or sending to an unknown channel', async () => {
    const socket = await connect('unknown@example.com');
    socket.send({ type: 'subscribe', channelId: '999999999' });
    socket.send({ type: 'message.send', channelId: '999999999', content: 'hi', nonce: 'nope' });
    const errors = await socket.waitFor('error', 2);
    expect(errors.map((e) => e.code)).toEqual(['channel_not_found', 'channel_not_found']);
    expect(errors[1]?.nonce).toBe('nope');
  });

  it('closes sockets that send oversized frames', async () => {
    const socket = await connect('big@example.com');
    const closed = new Promise<number>((resolve) => socket.socket.once('close', resolve));
    socket.send('x'.repeat(20 * 1024));
    expect(await closed).toBe(1009);
  });

  it('rate limits WebSocket sends and echoes the nonce', async () => {
    const limited = await infra.startApp({
      MESSAGE_RATE_MAX: '3',
      MESSAGE_RATE_WINDOW_SECONDS: '30',
    });
    const socket = await connect(`ratelimited-${Date.now()}@example.com`, limited);
    for (let i = 0; i < 5; i++) send(socket, 'spam', `r${i}`);
    await socket.waitFor('ack', 3);
    const errors = await socket.waitFor('error', 2);
    expect(errors.map((e) => [e.code, e.nonce])).toEqual([
      ['rate_limited', 'r3'],
      ['rate_limited', 'r4'],
    ]);
  });

  it('closes sockets with 1001 when the server shuts down', async () => {
    const doomed = await infra.startApp();
    const socket = await connect('shutdown@example.com', doomed);
    await socket.waitFor('hello');
    const closed = new Promise<number>((resolve) => socket.socket.once('close', resolve));
    await doomed.app.close();
    expect(await closed).toBe(1001);
  });
});
