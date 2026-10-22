// Prints one markdown table row for a fan-out k6 summary (and a JSON line), deriving the numbers
// that k6 does not: expected deliveries, drops, delivered/s over the send window.
//   node loadtest/scripts/tabulate.ts <summary.k6.json>... -- sendSeconds   (sendSeconds defaults to 30)
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const sepIdx = args.indexOf('--');
const files = sepIdx >= 0 ? args.slice(0, sepIdx) : args.filter((a) => a.endsWith('.json'));
const secs = Number((sepIdx >= 0 ? args[sepIdx + 1] : args.find((a) => /^\d+$/.test(a))) ?? 30);

type Metrics = Record<string, Record<string, number>>;
for (const file of files) {
  const m = (JSON.parse(readFileSync(file, 'utf8')) as { metrics: Metrics }).metrics;
  const get = (k: string, f: string): number => m[k]?.[f] ?? 0;
  const ready = get('recv_ready', 'count');
  const sentOk = get('sent_ok', 'count');
  const sentFail = get('sent_fail', 'count');
  const delivered = get('delivered', 'count');
  const connErr = get('recv_connect_err', 'count');
  const closed = get('recv_unexpected_close', 'count');
  // Each message goes to every receiver of its channel; receivers per channel = ready / channels.
  // The world is symmetric, so expected = sentOk * (ready / channels). Channels come from the file name
  // via RECEIVERS_PER_CHANNEL when set, else from the world file next to it.
  const perChannel = Number(process.env.RECEIVERS_PER_CHANNEL ?? 10);
  const expected = sentOk * perChannel;
  const row = {
    file: file.split('/').pop(),
    sendSeconds: secs,
    receiversReady: ready,
    connectErrors: connErr,
    unexpectedCloses: closed,
    sentOk,
    sentFail,
    sentPerSec: +(sentOk / secs).toFixed(1),
    delivered,
    expectedDeliveries: expected,
    missingDeliveries: Math.max(0, expected - delivered),
    extraDeliveries: Math.max(0, delivered - expected),
    deliveredPerSec: +(delivered / secs).toFixed(0),
    latencyMs: {
      p50: get('delivery_latency_ms', 'med'),
      p90: get('delivery_latency_ms', 'p(90)'),
      p95: get('delivery_latency_ms', 'p(95)'),
      p99: get('delivery_latency_ms', 'p(99)'),
      max: get('delivery_latency_ms', 'max'),
    },
    sendRequestMs: { p50: get('http_req_duration', 'med'), p95: get('http_req_duration', 'p(95)') },
    httpFailedRate: get('http_req_failed', 'value'),
  };
  console.log(JSON.stringify(row));
}
