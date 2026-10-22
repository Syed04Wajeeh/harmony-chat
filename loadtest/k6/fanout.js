// Fan-out latency: senders POST messages into channels whose subscribers are WebSocket clients
// spread over both app instances by nginx (least_conn). Each message carries its send time in the
// content (`k6:<epoch ms>:<n>`); receivers compute now - sentAt, so send -> receive latency covers
// the REST request, the Postgres transaction, the Redis publish and the WebSocket push. k6 and
// the server share one host clock.
//
//   WORLD=/work/world-fan.json RATE=500 SEND_SECONDS=30 k6 run fanout.js
import http from 'k6/http';
import { WebSocket } from 'k6/experimental/websockets';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { BASE, authHeaders, loginFor, readWorld, sentAtOf, wsUrl } from './lib.js';

const world = readWorld();
const GROUPS = world.channelIds.length;
const RECEIVERS_PER_GROUP = world.members - 1;
const RECEIVERS = GROUPS * RECEIVERS_PER_GROUP;
const RATE = Number(__ENV.RATE || 100);
const SEND_SECONDS = Number(__ENV.SEND_SECONDS || 30);
const CONNECT_SECONDS = Math.max(5, Math.ceil(RECEIVERS / 100));
const WARMUP_SECONDS = 5;
const DRAIN_SECONDS = 8;
const SEND_START = CONNECT_SECONDS + WARMUP_SECONDS;
const TOTAL_MS = (SEND_START + SEND_SECONDS + DRAIN_SECONDS) * 1000;

const latency = new Trend('delivery_latency_ms', true);
const delivered = new Counter('delivered');
const sentOk = new Counter('sent_ok');
const sentFail = new Counter('sent_fail');
const recvReady = new Counter('recv_ready');
const recvConnectErr = new Counter('recv_connect_err');
const recvDropped = new Counter('recv_unexpected_close');
const connApp1 = new Counter('recv_on_app_1');
const connApp2 = new Counter('recv_on_app_2');

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    receivers: {
      executor: 'shared-iterations',
      vus: RECEIVERS,
      iterations: RECEIVERS,
      maxDuration: `${SEND_START + SEND_SECONDS + DRAIN_SECONDS + 30}s`,
      exec: 'receiver',
    },
    senders: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${SEND_SECONDS}s`,
      startTime: `${SEND_START}s`,
      preAllocatedVUs: Math.min(400, Math.max(20, Math.ceil(RATE / 20))),
      maxVUs: 1000,
      exec: 'sender',
    },
  },
};

export function receiver() {
  const idx = exec.scenario.iterationInTest;
  const g = idx % GROUPS;
  const r = Math.floor(idx / GROUPS);
  const channelId = world.channelIds[g];
  const login = loginFor(world.prefix, g * world.members + 1 + r);
  const deadline = exec.scenario.startTime + TOTAL_MS;

  sleep(Math.random() * CONNECT_SECONDS);
  const ws = new WebSocket(wsUrl(), null, { headers: authHeaders(login) });
  let opened = false;
  ws.onopen = () => {
    opened = true;
  };
  ws.onmessage = (ev) => {
    const data = ev.data;
    if (typeof data !== 'string') return;
    const sentAt = sentAtOf(data);
    if (sentAt >= 0) {
      latency.add(Date.now() - sentAt);
      delivered.add(1);
    } else if (data.startsWith('{"type":"hello"')) {
      if (data.indexOf('"instanceId":"app-1"') >= 0) connApp1.add(1);
      else connApp2.add(1);
      ws.send(JSON.stringify({ type: 'subscribe', channelId }));
    } else if (data.startsWith('{"type":"backfill"')) {
      recvReady.add(1);
    }
  };
  ws.onerror = () => {
    if (!opened) recvConnectErr.add(1);
  };
  ws.onclose = () => {
    if (opened && Date.now() < deadline - 500) recvDropped.add(1);
  };
  setTimeout(() => ws.close(), Math.max(0, deadline - Date.now()));
}

export function sender() {
  const n = exec.scenario.iterationInTest;
  const g = n % GROUPS;
  const res = http.post(
    `${BASE}/api/channels/${world.channelIds[g]}/messages`,
    `{"content":"k6:${Date.now()}:${n}"}`,
    {
      headers: authHeaders(loginFor(world.prefix, g * world.members), {
        'Content-Type': 'application/json',
      }),
      tags: { name: 'send' },
    },
  );
  if (res.status === 201) sentOk.add(1);
  else sentFail.add(1);
}
