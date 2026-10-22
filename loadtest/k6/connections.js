// Connection capacity: ramps idle, authenticated WebSocket connections to TARGET, each subscribing
// to one channel, holds them, and reports how many became ready, how many were refused or dropped,
// and the handshake / hello / subscribe times. Memory per connection is derived from the app
// containers' RSS, sampled by loadtest/scripts/stats.ts during the hold.
//
// One VU opens TARGET / VUS sockets (k6/experimental/websockets is event-loop based), because a VU
// per connection would exhaust the load generator's memory long before the server's.
//
//   WORLD=/work/world-cap.json TARGET=2000 VUS=100 RAMP_SECONDS=60 HOLD_SECONDS=30 k6 run connections.js
import { WebSocket } from 'k6/experimental/websockets';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { authHeaders, loginFor, readWorld, wsUrl } from './lib.js';

const world = readWorld();
const TARGET = Number(__ENV.TARGET || 2000);
const VUS = Number(__ENV.VUS || 100);
const PER_VU = Math.ceil(TARGET / VUS);
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS || 60);
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || 30);
const READY_TIMEOUT_MS = 20000;

const handshake = new Trend('handshake_ms', true);
const helloTime = new Trend('hello_ms', true);
const subscribeTime = new Trend('subscribe_ms', true);
const ready = new Counter('conns_ready');
const dropped = new Counter('conns_dropped_while_held');
const failedRate = new Rate('conn_failed');
const onApp1 = new Counter('conns_on_app_1');
const onApp2 = new Counter('conns_on_app_2');
const presenceFrames = new Counter('presence_frames_received');

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    connect: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: `${RAMP_SECONDS + HOLD_SECONDS + 60}s`,
    },
  },
  // Stop early when more than 1% of connection attempts fail.
  thresholds: {
    conn_failed: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '10s' }],
  },
};

function openOne(userIndex, deadline) {
  const group = Math.floor(userIndex / world.members);
  const channelId = world.channelIds[group];
  if (!channelId) return;
  const t0 = Date.now();
  const ws = new WebSocket(wsUrl(), null, {
    headers: authHeaders(loginFor(world.prefix, userIndex)),
  });
  let opened = false;
  let isReady = false;
  let settled = false;
  const fail = () => {
    if (settled) return;
    settled = true;
    failedRate.add(true);
  };
  ws.onopen = () => {
    opened = true;
    handshake.add(Date.now() - t0);
  };
  ws.onmessage = (ev) => {
    const data = ev.data;
    if (typeof data !== 'string') return;
    if (data.startsWith('{"type":"presence.updated"')) {
      presenceFrames.add(1);
    } else if (data.startsWith('{"type":"hello"')) {
      helloTime.add(Date.now() - t0);
      if (data.indexOf('"instanceId":"app-1"') >= 0) onApp1.add(1);
      else onApp2.add(1);
      ws.send(JSON.stringify({ type: 'subscribe', channelId }));
    } else if (data.startsWith('{"type":"backfill"') && !isReady) {
      isReady = true;
      subscribeTime.add(Date.now() - t0);
      if (!settled) {
        settled = true;
        failedRate.add(false);
      }
      ready.add(1);
    }
  };
  ws.onerror = () => fail();
  ws.onclose = () => {
    if (!isReady) fail();
    else if (Date.now() < deadline - 500) dropped.add(1);
  };
  setTimeout(() => {
    if (!isReady) fail();
  }, READY_TIMEOUT_MS);
  setTimeout(() => ws.close(), Math.max(0, deadline - Date.now()));
  void opened;
}

export default function () {
  const vu = exec.scenario.iterationInTest; // 0..VUS-1, one iteration per VU
  const start = Date.now();
  const deadline = start + (RAMP_SECONDS + HOLD_SECONDS) * 1000;
  for (let s = 0; s < PER_VU; s++) {
    const userIndex = vu * PER_VU + s;
    if (userIndex >= TARGET) break;
    const offset =
      (s / PER_VU) * RAMP_SECONDS * 1000 + Math.random() * ((RAMP_SECONDS * 1000) / PER_VU);
    setTimeout(() => openOne(userIndex, deadline), offset);
  }
}
