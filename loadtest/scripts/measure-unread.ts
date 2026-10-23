// Latency of the endpoints that compute unread counts, for one user, sequential requests.
//   node loadtest/scripts/measure-unread.ts [--login load-cap-0@example.com] [--n 40]
import { parseArgs } from 'node:util';
import { BASE, headersFor, summarize } from './lib.ts';

const { values } = parseArgs({
  options: {
    login: { type: 'string', default: 'load-cap-0@example.com' },
    n: { type: 'string', default: '40' },
  },
});
const login = values.login;
for (const path of ['/api/guilds', '/api/channels', '/api/guilds']) {
  const times: number[] = [];
  let unread = 0;
  for (let i = 0; i < Number(values.n) + 5; i++) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, { headers: headersFor(login) });
    const body = await res.json();
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    if (i >= 5) times.push(ms); // first five are warm-up
    if (i === 0) unread = JSON.stringify(body).length;
  }
  const s = summarize(times);
  console.log(
    `${path.padEnd(14)} n=${times.length} p50=${s.p50.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms max=${s.max.toFixed(1)}ms (body ${unread} B)`,
  );
}
