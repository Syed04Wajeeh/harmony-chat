// Failover test against the harmony-load stack: K clients spread over both instances (through the
// balanced nginx listener) receive a steady stream of sequence-numbered messages from S concurrent
// REST senders; app1 is `docker kill`ed mid-run and restarted later.
// Clients reconnect through nginx with the web client's backoff, resubscribe with lastSeenId and
// backfill. Afterwards every client's received set is compared with what the database holds.
//   node loadtest/scripts/failover.ts [--clients 20] [--senders 4] [--rate 100] [--duration 40] \
//        [--kill-at 10] [--restart-at 25] [--out loadtest/results/...json]
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import {
  BASE,
  Client,
  api,
  buildWorld,
  headersFor,
  loginFor,
  sleep,
  summarize,
  type Frame,
  type MessageDto,
} from './lib.ts';

const run = promisify(execFile);
const { values } = parseArgs({
  options: {
    clients: { type: 'string', default: '20' },
    senders: { type: 'string', default: '4' },
    rate: { type: 'string', default: '100' },
    duration: { type: 'string', default: '40' },
    'kill-at': { type: 'string', default: '10' },
    'restart-at': { type: 'string', default: '25' },
    container: { type: 'string', default: 'harmony-load-app1-1' },
    'extra-delay-ms': { type: 'string', default: '0' },
    out: { type: 'string' },
  },
});
const K = Number(values.clients);
const S = Number(values.senders);
const RATE = Number(values.rate);
const DURATION = Number(values.duration) * 1000;
const KILL_AT = Number(values['kill-at']) * 1000;
const RESTART_AT = Number(values['restart-at']) * 1000;
const CONTAINER = values.container;
/** Added to each affected client's first reconnect delay, to force a gap bigger than one backfill page. */
const EXTRA_DELAY = Number(values['extra-delay-ms']);
const prefix = `fo${Date.now() % 1_000_000}`;

const world = await buildWorld({ prefix, groups: 1, members: S + K });
const { channelId } = world.groups[0] as { channelId: string };
const senderLogins = Array.from({ length: S }, (_, i) => loginFor(prefix, i));
const receiverLogins = Array.from({ length: K }, (_, i) => loginFor(prefix, S + i));

// Same schedule as the web client's backoffDelay(): 500ms * 2^attempt, capped, half jittered.
const backoff = (attempt: number) => {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
};

interface Reconnect {
  closedAt: number;
  helloAt: number;
  resubscribedAt: number;
  failedAttempts: number;
  fromInstance: string;
  toInstance: string;
  backfilled: number;
}

class Receiver {
  ids = new Set<string>();
  raw = 0;
  maxId = 0n;
  client: Client | null = null;
  firstInstance = '';
  reconnects: Reconnect[] = [];
  stopping = false;
  private pending: { closedAt: number; fromInstance: string; failed: number } | null = null;

  readonly login: string;

  constructor(login: string) {
    this.login = login;
  }

  private take(id: string) {
    this.raw++;
    this.ids.add(id);
    const n = BigInt(id);
    if (n > this.maxId) this.maxId = n;
  }

  async start() {
    await this.open();
    this.firstInstance = this.client?.instanceId ?? '';
  }

  private async open(): Promise<void> {
    const client = new Client(this.login, BASE);
    client.keepFrames = false;
    client.onFrame = (frame: Frame) => {
      if (frame.type === 'message.created') {
        const m = frame.message as MessageDto;
        if (m.content.startsWith('fo:')) this.take(m.id);
      } else if (frame.type === 'backfill') {
        for (const m of frame.messages as MessageDto[])
          if (m.content.startsWith('fo:')) this.take(m.id);
      }
    };
    await client.connect(5000);
    this.client = client;
    client.ws.on('close', () => {
      if (this.stopping || this.client !== client) return;
      this.pending = { closedAt: Date.now(), fromInstance: client.instanceId, failed: 0 };
      void this.reconnect();
    });
    const helloAt = Date.now();
    // Resubscribe with lastSeenId. Per docs/api/protocol.md, `hasMore: true` means the gap is bigger
    // than one backfill page: the client must reload over REST. (A first draft of this script
    // instead re-subscribed with the highest id seen so far, which jumps over the middle of the gap
    // because live messages arrive while the backfill is pending; it lost 85 messages in one run.)
    const lastSeen = this.maxId > 0n ? this.maxId.toString() : undefined;
    const frame = await client.subscribe(channelId, lastSeen, 10_000);
    let backfilled = (frame.messages as MessageDto[]).length;
    if (frame.hasMore && lastSeen) backfilled += await this.fillGapOverRest(BigInt(lastSeen));
    if (this.pending) {
      this.reconnects.push({
        closedAt: this.pending.closedAt,
        helloAt,
        resubscribedAt: Date.now(),
        failedAttempts: this.pending.failed,
        fromInstance: this.pending.fromInstance,
        toInstance: client.instanceId,
        backfilled,
      });
      this.pending = null;
    }
  }

  /** Pages the channel history backwards over REST until it reaches `after`. Returns messages read. */
  private async fillGapOverRest(after: bigint): Promise<number> {
    let read = 0;
    for (let before: string | undefined; ;) {
      const page = await api<{ messages: MessageDto[]; hasMore: boolean }>(
        this.login,
        'GET',
        `/api/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`,
      );
      for (const m of page.messages)
        if (BigInt(m.id) > after && m.content.startsWith('fo:')) this.take(m.id);
      read += page.messages.length;
      const oldest = page.messages[0]?.id;
      if (!page.hasMore || !oldest || BigInt(oldest) <= after) return read;
      before = oldest;
    }
  }

  private async reconnect(): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      await sleep(backoff(attempt) + (attempt === 0 ? EXTRA_DELAY : 0));
      try {
        await this.open();
        return;
      } catch {
        if (this.pending) this.pending.failed++;
      }
    }
  }

  stop() {
    this.stopping = true;
    this.client?.close();
  }
}

const receivers = receiverLogins.map((l) => new Receiver(l));
await Promise.all(receivers.map((r) => r.start()));
const startSpread: Record<string, number> = {};
for (const r of receivers) startSpread[r.firstInstance] = (startSpread[r.firstInstance] ?? 0) + 1;
console.log('receivers per instance at start:', startSpread);

// --- senders: S concurrent REST posters through nginx, sequence-numbered ---
let seq = 0;
const sendLog: { seq: number; at: number; status: number | 'exception'; ms: number }[] = [];
const sendTick = (login: string) => async () => {
  const n = seq++;
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: headersFor(login, { 'content-type': 'application/json' }),
      body: JSON.stringify({ content: `fo:${n}:${t0}` }),
    });
    await res.arrayBuffer();
    sendLog.push({ seq: n, at: t0, status: res.status, ms: Date.now() - t0 });
  } catch {
    sendLog.push({ seq: n, at: t0, status: 'exception', ms: Date.now() - t0 });
  }
};
const timers = senderLogins.map((login) =>
  setInterval(() => void sendTick(login)(), (1000 * S) / RATE),
);

// --- probes: after the restart, how long until nginx hands a fresh connection to app1 again ---
const probeLog: { at: number; instance: string }[] = [];
let probing = false;
async function probeLoop(until: number) {
  probing = true;
  while (Date.now() < until) {
    const c = new Client(receiverLogins[0] as string, BASE);
    try {
      await c.connect(3000);
      probeLog.push({ at: Date.now(), instance: c.instanceId });
    } catch {
      probeLog.push({ at: Date.now(), instance: 'connect-failed' });
    }
    c.close();
    await sleep(250);
  }
  probing = false;
}

const t0 = Date.now();
let healthyAt = 0;

await sleep(KILL_AT);
const killedAt = Date.now();
await run('docker', ['kill', CONTAINER]);
const killReturnedAt = Date.now();
console.log(`killed ${CONTAINER} at t=${((killedAt - t0) / 1000).toFixed(2)}s`);

await sleep(Math.max(0, RESTART_AT - (Date.now() - t0)));
const restartedAt = Date.now();
await run('docker', ['start', CONTAINER]);
console.log(`started ${CONTAINER} at t=${((restartedAt - t0) / 1000).toFixed(2)}s`);
const probeUntil = t0 + DURATION + 40_000;
void probeLoop(probeUntil);
for (;;) {
  const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Health.Status}}', CONTAINER]);
  if (stdout.trim() === 'healthy') {
    healthyAt = Date.now();
    break;
  }
  await sleep(500);
}
console.log(`app1 healthy again at t=${((healthyAt - t0) / 1000).toFixed(2)}s`);

await sleep(Math.max(0, DURATION - (Date.now() - t0)));
timers.forEach(clearInterval);
await sleep(5000); // let in-flight requests and fan-out drain
// Give the probes up to 35s after app1 turned healthy to see nginx hand a connection to it again.
while (
  probing &&
  Date.now() < healthyAt + 35_000 &&
  !probeLog.some((p) => p.instance === 'app-1' && p.at > healthyAt)
) {
  await sleep(500);
}
const returned = probeLog.find((p) => p.instance === 'app-1' && p.at > healthyAt);
await sleep(1000);

// --- truth: what Postgres holds, via REST history ---
const persisted: MessageDto[] = [];
for (let before: string | undefined; ;) {
  const page = await api<{ messages: MessageDto[]; hasMore: boolean }>(
    senderLogins[0] as string,
    'GET',
    `/api/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`,
  );
  persisted.push(...page.messages);
  if (!page.hasMore) break;
  before = page.messages[0]?.id;
}
const dbIds = [...new Set(persisted.filter((m) => m.content.startsWith('fo:')).map((m) => m.id))];
const dbSet = new Set(dbIds);

receivers.forEach((r) => r.stop());

const perClient = receivers.map((r) => {
  const missing = dbIds.filter((id) => !r.ids.has(id));
  const foreign = [...r.ids].filter((id) => !dbSet.has(id)).length;
  return {
    login: r.login.replace(/@.*/, ''),
    startedOn: r.firstInstance,
    reconnects: r.reconnects.length,
    received: r.ids.size,
    rawFrames: r.raw,
    duplicatesBeforeDedupe: r.raw - r.ids.size,
    missing: missing.length,
    foreign,
    missingIds: missing.slice(0, 10),
  };
});
const reconnects = receivers.flatMap((r) => r.reconnects);
const killDetect = reconnects.map((r) => r.closedAt - killedAt);
const result = {
  scenario: 'failover',
  date: new Date().toISOString(),
  params: {
    clients: K,
    senders: S,
    targetRatePerSec: RATE,
    durationSec: DURATION / 1000,
    killAtSec: KILL_AT / 1000,
    restartAtSec: RESTART_AT / 1000,
    extraReconnectDelayMs: EXTRA_DELAY,
  },
  receiversPerInstanceAtStart: startSpread,
  killedAtOffsetMs: killedAt - t0,
  killCommandMs: killReturnedAt - killedAt,
  restart: { startedOffsetMs: restartedAt - t0, healthyAfterMs: healthyAt - restartedAt },
  nginxRoutesToApp1AgainAfterHealthyMs: returned ? returned.at - healthyAt : null,
  probeInstanceCounts: probeLog.reduce<Record<string, number>>(
    (m, p) => ((m[p.instance] = (m[p.instance] ?? 0) + 1), m),
    {},
  ),
  sent: {
    attempted: sendLog.length,
    ok201: sendLog.filter((s) => s.status === 201).length,
    failed: sendLog
      .filter((s) => s.status !== 201)
      .map((s) => ({ seq: s.seq, atOffsetMs: s.at - t0, status: s.status, ms: s.ms })),
  },
  persistedInDb: dbIds.length,
  clientsAffected: reconnects.length,
  reconnectCount: reconnects.length,
  msFromKillToCloseEvent: summarize(killDetect),
  reconnectMs_closeToHello: summarize(reconnects.map((r) => r.helloAt - r.closedAt)),
  reconnectMs_closeToResubscribed: summarize(reconnects.map((r) => r.resubscribedAt - r.closedAt)),
  failedConnectAttempts: reconnects.reduce((a, r) => a + r.failedAttempts, 0),
  backfilledMessages: summarize(reconnects.map((r) => r.backfilled)),
  reconnectedTo: reconnects.reduce<Record<string, number>>(
    (m, r) => ((m[r.toInstance] = (m[r.toInstance] ?? 0) + 1), m),
    {},
  ),
  totalMissingAcrossClients: perClient.reduce((a, c) => a + c.missing, 0),
  clientsWithMissing: perClient.filter((c) => c.missing > 0).length,
  clientsWithForeign: perClient.filter((c) => c.foreign > 0).length,
  perClient,
  pass: perClient.every((c) => c.missing === 0 && c.foreign === 0),
};
console.log(JSON.stringify({ ...result, perClient: undefined }, null, 2));
console.log(
  'per-client with problems:',
  perClient.filter((c) => c.missing > 0 || c.foreign > 0),
);
if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
