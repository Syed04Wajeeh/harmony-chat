import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TestSocket,
  createChannel,
  createInfra,
  settle,
  type Infra,
  type TestApp,
} from './support/harness.js';

describe('two app instances sharing Postgres and Redis', () => {
  let infra: Infra;
  let a: TestApp;
  let b: TestApp;
  let channelId: string;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    infra = createInfra();
    [a, b] = await Promise.all([infra.startApp(), infra.startApp()]);
    channelId = await createChannel(infra.db, ['carol@example.com', 'dave@example.com']);
  });

  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  it('delivers a message sent through instance A to a client on instance B', async () => {
    expect(a.config.INSTANCE_ID).not.toBe(b.config.INSTANCE_ID);
    const sender = await TestSocket.connect(a, 'carol@example.com');
    const receiver = await TestSocket.connect(b, 'dave@example.com');
    sockets.push(sender, receiver);
    await sender.subscribe(channelId);
    await receiver.subscribe(channelId);

    sender.send({ type: 'message.send', channelId, content: 'across instances', nonce: 'x1' });
    const [ack] = await sender.waitFor('ack');
    const [received] = await receiver.waitFor('message.created');
    await settle();

    expect(received?.message).toEqual(ack?.message);
    expect(received?.message.content).toBe('across instances');
    expect(receiver.of('message.created')).toHaveLength(1);
    expect((await receiver.waitFor('hello'))[0]?.instanceId).toBe(b.config.INSTANCE_ID);
  });
});
