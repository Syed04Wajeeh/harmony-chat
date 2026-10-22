// Live two-instance proof against the harmony-load stack.
// Client A is pinned to app1 and client B to app2 (nginx listeners :8571 / :8572, which exist only in
// the load compose); each sends N/2 messages and both must receive all N exactly once.
//   node loadtest/scripts/cross-instance.ts [--messages 1000] [--out loadtest/results/...json]
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  BASE,
  Client,
  api,
  buildWorld,
  loginFor,
  sleep,
  summarize,
  type MessageDto,
} from './lib.ts';

const { values } = parseArgs({
  options: {
    messages: { type: 'string', default: '1000' },
    out: { type: 'string' },
    'base-a': { type: 'string', default: 'http://127.0.0.1:8571' },
    'base-b': { type: 'string', default: 'http://127.0.0.1:8572' },
  },
});
const N = Number(values.messages);
const prefix = `xi${Date.now() % 1_000_000}`;

const world = await buildWorld({ prefix, groups: 1, members: 2 });
const { channelId } = world.groups[0] as { channelId: string };
const loginA = loginFor(prefix, 0);
const loginB = loginFor(prefix, 1);

const a = new Client(loginA, values['base-a']);
const b = new Client(loginB, values['base-b']);
await Promise.all([a.connect(), b.connect()]);
console.log(`A pinned to ${a.instanceId}, B pinned to ${b.instanceId}`);
if (a.instanceId === b.instanceId) throw new Error('both clients landed on the same instance');
await Promise.all([a.subscribe(channelId), b.subscribe(channelId)]);

interface Received {
  id: string;
  from: string;
  seq: number;
  sentAt: number;
  receivedAt: number;
}
const track = (client: Client) => {
  const got: Received[] = [];
  client.onFrame = (frame, receivedAt) => {
    if (frame.type !== 'message.created') return;
    const m = frame.message as MessageDto;
    const parts = m.content.split(':');
    if (parts[0] !== 'xi') return;
    got.push({
      id: m.id,
      from: String(parts[2]),
      seq: Number(parts[1]),
      sentAt: Number(parts[3]),
      receivedAt,
    });
  };
  return got;
};
const gotA = track(a);
const gotB = track(b);

const acked = new Map<number, string>();
async function sendRange(client: Client, from: string, seqs: number[]) {
  for (const seq of seqs) {
    const nonce = `${from}-${seq}`;
    const ack = client.waitFor((f) => f.type === 'ack' && f.nonce === nonce);
    client.send({
      type: 'message.send',
      channelId,
      content: `xi:${seq}:${from}:${Date.now()}`,
      nonce,
    });
    const frame = await ack;
    acked.set(seq, String((frame.message as MessageDto).id));
  }
}
const seqs = Array.from({ length: N }, (_, i) => i);
const started = Date.now();
await Promise.all([
  sendRange(
    a,
    'A',
    seqs.filter((s) => s % 2 === 0),
  ),
  sendRange(
    b,
    'B',
    seqs.filter((s) => s % 2 === 1),
  ),
]);
const sendSeconds = (Date.now() - started) / 1000;
await sleep(3000);

// What the database holds for this channel, paged through the REST API.
const persisted: MessageDto[] = [];
for (let before: string | undefined; ;) {
  const page = await api<{ messages: MessageDto[]; hasMore: boolean }>(
    loginA,
    'GET',
    `/api/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`,
  );
  persisted.push(...page.messages);
  if (!page.hasMore) break;
  before = page.messages[0]?.id;
}
const dbIds = new Set(persisted.filter((m) => m.content.startsWith('xi:')).map((m) => m.id));

function verify(name: string, got: Received[]) {
  const counts = new Map<string, number>();
  for (const r of got) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  const duplicates = [...counts.values()].filter((c) => c > 1).length;
  const missingVsDb = [...dbIds].filter((id) => !counts.has(id)).length;
  const missingVsAcks = [...acked.values()].filter((id) => !counts.has(id)).length;
  const foreign = [...counts.keys()].filter((id) => !dbIds.has(id)).length;
  return {
    name,
    received: got.length,
    unique: counts.size,
    duplicates,
    missingVsDb,
    missingVsAcks,
    foreign,
  };
}
const resA = verify('A (app1)', gotA);
const resB = verify('B (app2)', gotB);

// Latency of messages that crossed instances: A->B and B->A (same host clock, so comparable).
const aToB = gotB.filter((r) => r.from === 'A').map((r) => r.receivedAt - r.sentAt);
const bToA = gotA.filter((r) => r.from === 'B').map((r) => r.receivedAt - r.sentAt);

// How least_conn spreads connections through the balanced listener.
const spread: Record<string, number> = {};
const lb: Client[] = [];
for (let i = 0; i < 60; i++) {
  const c = new Client(loginA, BASE);
  await c.connect();
  lb.push(c);
  spread[c.instanceId] = (spread[c.instanceId] ?? 0) + 1;
}
lb.forEach((c) => c.close());

const ok =
  acked.size === N &&
  dbIds.size === N &&
  [resA, resB].every(
    (r) =>
      r.received === N &&
      r.unique === N &&
      r.duplicates === 0 &&
      r.missingVsDb === 0 &&
      r.foreign === 0,
  );
const result = {
  scenario: 'cross-instance',
  date: new Date().toISOString(),
  messages: N,
  clientA: { pinnedTo: a.instanceId },
  clientB: { pinnedTo: b.instanceId },
  sendSeconds,
  acked: acked.size,
  persistedInDb: dbIds.size,
  receivers: [resA, resB],
  latencyMs: { aToB: summarize(aToB), bToA: summarize(bToA) },
  leastConnSpreadOf60: spread,
  pass: ok,
};
console.log(JSON.stringify(result, null, 2));
if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2));
a.close();
b.close();
process.exit(ok ? 0 : 1);
