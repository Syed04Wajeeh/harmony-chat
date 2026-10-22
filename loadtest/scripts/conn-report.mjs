// Prints the headline numbers of a connection-capacity run from its k6 summary and stats CSV.
//   node loadtest/scripts/conn-report.mjs <k6.json> <stats.csv> <ramp_s> <hold_s>
import { readFileSync } from 'node:fs';

const [k6, csv, rampArg, holdArg] = process.argv.slice(2);
const ramp = Number(rampArg);
const hold = Number(holdArg);
const m = JSON.parse(readFileSync(k6, 'utf8')).metrics;
const c = (k) => m[k]?.count ?? 0;
const t = (k, f) => m[k]?.[f];
console.log({
  ready: c('conns_ready'),
  droppedWhileHeld: c('conns_dropped_while_held'),
  failedRate: m.conn_failed?.value,
  onApp1: c('conns_on_app_1'),
  onApp2: c('conns_on_app_2'),
  handshakeMs: {
    p50: t('handshake_ms', 'med'),
    p95: t('handshake_ms', 'p(95)'),
    max: t('handshake_ms', 'max'),
  },
  helloMs: { p50: t('hello_ms', 'med'), p95: t('hello_ms', 'p(95)') },
  subscribeMs: {
    p50: t('subscribe_ms', 'med'),
    p95: t('subscribe_ms', 'p(95)'),
    max: t('subscribe_ms', 'max'),
  },
  presenceFramesReceived: c('presence_frames_received'),
});
// Plateau = the part of the hold window after the ramp; idle = the first samples before any load.
const rows = readFileSync(csv, 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((l) => l.split(','));
const by = {};
for (const [time, name, cpu, mem, rss] of rows) {
  (by[name] ??= []).push({ t: +time, cpu: +cpu, mem: +mem, rss: rss === '' ? NaN : +rss });
}
const avg = (a, k) => (a.length ? (a.reduce((p, x) => p + x[k], 0) / a.length).toFixed(1) : 'n/a');
const max = (a, k) => (a.length ? Math.max(...a.map((x) => x[k])).toFixed(1) : 'n/a');
for (const name of ['app1', 'app2', 'postgres', 'redis', 'nginx']) {
  const s = by[name] ?? [];
  const base = s.filter((x) => x.t < 3);
  const plateau = s.filter((x) => x.t > ramp + hold * 0.4 && x.t < ramp + hold);
  const busy = s.filter((x) => x.t < ramp + hold);
  console.log(
    name,
    '| idle rss/mem MiB',
    avg(base, 'rss'),
    avg(base, 'mem'),
    '| plateau rss avg/max',
    avg(plateau, 'rss'),
    max(plateau, 'rss'),
    'mem avg',
    avg(plateau, 'mem'),
    '| cpu% avg/max ramp+hold',
    avg(busy, 'cpu'),
    max(busy, 'cpu'),
  );
}
