// Recreate test: replace app1 with a NEW container on a NEW IP (what `docker compose up -d --build`
// does on a deploy) and show that traffic returns to it without restarting nginx.
// A short-lived filler container takes app1's old address, so the replacement cannot get it back.
//   node loadtest/scripts/recreate.ts [--out loadtest/results/...json]
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { BASE, Client, headersFor, loginFor, sleep } from './lib.ts';

const run = promisify(execFile);
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const COMPOSE = [
  'compose',
  '-p',
  'harmony-load',
  '-f',
  'deploy/load/compose.load.yml',
  '--env-file',
  'deploy/load/.env',
];
const ip = async (name: string) =>
  (
    await run('docker', [
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      name,
    ])
  ).stdout.trim();

const login = loginFor('cap', 1);
const log: { t: number; kind: 'rest' | 'ws'; result: string }[] = [];
let stop = false;
const t0 = Date.now();
async function probe() {
  while (!stop) {
    try {
      const res = await fetch(`${BASE}/api/me`, { headers: headersFor(login) });
      await res.arrayBuffer();
      log.push({ t: Date.now() - t0, kind: 'rest', result: String(res.status) });
    } catch {
      log.push({ t: Date.now() - t0, kind: 'rest', result: 'exception' });
    }
    const c = new Client(login, BASE);
    try {
      await c.connect(3000);
      log.push({ t: Date.now() - t0, kind: 'ws', result: c.instanceId });
    } catch {
      log.push({ t: Date.now() - t0, kind: 'ws', result: 'connect-failed' });
    }
    c.close();
    await sleep(150);
  }
}
const prober = probe();
await sleep(2000);

const oldIp = await ip('harmony-load-app1-1');
await run('docker', ['stop', 'harmony-load-app1-1']);
const stoppedAt = Date.now() - t0;
await run('docker', [
  'run',
  '-d',
  '--name',
  'harmony-load-ipfiller',
  '--network',
  'harmony-load_load',
  '--entrypoint',
  'sleep',
  'nginx:1.27-alpine',
  '600',
]);
const fillerIp = await ip('harmony-load-ipfiller');
await run('docker', [...COMPOSE, 'up', '-d', '--force-recreate', '--no-deps', '--wait', 'app1']);
const recreatedAt = Date.now() - t0;
const newIp = await ip('harmony-load-app1-1');
await run('docker', ['rm', '-f', 'harmony-load-ipfiller']);
console.log(
  `app1 ip ${oldIp} -> ${newIp} (filler held ${fillerIp}); stopped at ${stoppedAt}ms, healthy again at ${recreatedAt}ms`,
);

// Wait up to 40s for a connection to land on app-1 again.
const deadline = Date.now() + 40_000;
let backAt: number | null = null;
while (Date.now() < deadline) {
  const hit = log.find((l) => l.kind === 'ws' && l.result === 'app-1' && l.t > recreatedAt);
  if (hit) {
    backAt = hit.t;
    break;
  }
  await sleep(250);
}
await sleep(1500);
stop = true;
await prober;
const count = (pred: (l: (typeof log)[number]) => boolean) => log.filter(pred).length;
const result = {
  scenario: 'recreate-app1-new-ip',
  date: new Date().toISOString(),
  oldIp,
  newIp,
  ipChanged: oldIp !== newIp,
  nginxRestarted: false,
  appStoppedAtMs: stoppedAt,
  appHealthyAgainAtMs: recreatedAt,
  firstConnectionBackOnApp1AtMs: backAt,
  msFromHealthyToTrafficOnApp1: backAt === null ? null : backAt - recreatedAt,
  restProbes: {
    total: count((l) => l.kind === 'rest'),
    ok200: count((l) => l.kind === 'rest' && l.result === '200'),
    non200: log
      .filter((l) => l.kind === 'rest' && l.result !== '200')
      .map((l) => `${l.t}ms:${l.result}`),
  },
  wsProbes: {
    total: count((l) => l.kind === 'ws'),
    connectFailed: count((l) => l.kind === 'ws' && l.result === 'connect-failed'),
    app1: count((l) => l.kind === 'ws' && l.result === 'app-1'),
    app2: count((l) => l.kind === 'ws' && l.result === 'app-2'),
  },
  pass: backAt !== null,
};
console.log(JSON.stringify(result, null, 2));
if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
