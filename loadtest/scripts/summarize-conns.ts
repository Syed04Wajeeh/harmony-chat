// Prints one summary of a connection-capacity run from its raw files in loadtest/results.
//   node loadtest/scripts/summarize-conns.ts <result-name-prefix> <ramp_s> <hold_s>
// e.g. node loadtest/scripts/summarize-conns.ts 2026-10-23-connections-before-2000 60 30
// CPU and RSS are the docker-stats / VmRSS samples taken every 2 s while k6 ran (first ramp+hold
// seconds only, so the idle tail is not averaged in). Rates are totals over ramp+hold seconds.
import { readFileSync } from 'node:fs';

const [prefix, rampArg, holdArg] = process.argv.slice(2);
if (!prefix || !rampArg || !holdArg)
  throw new Error('usage: summarize-conns.ts <prefix> <ramp> <hold>');
const dir = new URL('../results/', import.meta.url).pathname;
const wall = Number(rampArg) + Number(holdArg);

const k6 = (
  JSON.parse(readFileSync(`${dir}${prefix}.k6.json`, 'utf8')) as {
    metrics: Record<string, Record<string, number>>;
  }
).metrics;
const m = (name: string, key: string): number | undefined => k6[name]?.[key];
const ready = m('conns_ready', 'count') ?? 0;
const failedRate = m('conn_failed', 'value') ?? 0;
const attempts = (k6.conn_failed?.passes ?? 0) + (k6.conn_failed?.fails ?? 0);
const frames = m('presence_frames_received', 'count') ?? 0;
const updates = m('presence_updates_received', 'count') ?? 0;
const bytes = m('presence_bytes_received', 'count') ?? 0;

const rows = readFileSync(`${dir}${prefix}.stats.csv`, 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => line.split(','))
  .map(([t, c, cpu, , rss]) => ({
    t: Number(t),
    c: c as string,
    cpu: Number(cpu),
    rss: Number(rss),
  }))
  .filter((r) => r.t <= wall + 4);
const stat = (container: string) => {
  const own = rows.filter((r) => r.c === container);
  const cpus = own.map((r) => r.cpu);
  const rss = own.map((r) => r.rss).filter((x) => !Number.isNaN(x));
  return {
    avg: cpus.reduce((a, b) => a + b, 0) / Math.max(1, cpus.length),
    max: Math.max(...cpus),
    rssIdle: rss[0],
    rssMax: rss.length ? Math.max(...rss) : undefined,
  };
};
const est = readFileSync(`${dir}${prefix}.established.txt`, 'utf8')
  .split('\n')
  .map((l) => /established=(\d+)/.exec(l)?.[1])
  .filter(Boolean)
  .map(Number);
const f = (x: number | undefined, d = 0) => (x === undefined ? 'n/a' : x.toFixed(d));
const a1 = stat('app1');
const a2 = stat('app2');
const ng = stat('nginx');
console.log(
  JSON.stringify(
    {
      run: prefix,
      ready,
      attempts,
      failedPct: +(failedRate * 100).toFixed(2),
      peakEstablished: Math.max(0, ...est),
      handshakeMs: { p50: m('handshake_ms', 'med'), p95: m('handshake_ms', 'p(95)') },
      helloMs: { p50: m('hello_ms', 'med'), p95: m('hello_ms', 'p(95)') },
      subscribeMs: { p50: m('subscribe_ms', 'med'), p95: m('subscribe_ms', 'p(95)') },
      presence: {
        frames,
        updates,
        framesPerSec: +(frames / wall).toFixed(0),
        updatesPerSec: +(updates / wall).toFixed(0),
        MBreceived: +(bytes / 1e6).toFixed(1),
      },
      snapshot: {
        ms: m('presence_snapshot_ms', 'avg'),
        bytes: m('presence_snapshot_bytes', 'avg'),
      },
      cpuPct: {
        nginx: `${f(ng.avg)} avg / ${f(ng.max)} max`,
        app1: `${f(a1.avg)} avg / ${f(a1.max)} max`,
        app2: `${f(a2.avg)} avg / ${f(a2.max)} max`,
      },
      rssMiB: {
        app1: `${f(a1.rssIdle)} -> ${f(a1.rssMax)}`,
        app2: `${f(a2.rssIdle)} -> ${f(a2.rssMax)}`,
      },
    },
    null,
    1,
  ),
);
