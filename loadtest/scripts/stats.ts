// Samples the harmony-load containers while a test runs and writes a CSV:
//   time_s, container, cpu_pct, mem_mib (cgroup, includes page cache), rss_mib (VmRSS of PID 1's node), host_load1
//   node loadtest/scripts/stats.ts <out.csv> <seconds> [intervalSeconds]
// RSS is read from /proc/<pid>/status of the container's main process, which is what "app RSS" means.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [out, secondsArg, intervalArg] = process.argv.slice(2);
if (!out || !secondsArg) throw new Error('usage: stats.ts <out.csv> <seconds> [interval]');
const seconds = Number(secondsArg);
const interval = Number(intervalArg ?? 2);
const names = ['app1', 'app2', 'postgres', 'redis', 'nginx', 'worker'].map(
  (s) => `harmony-load-${s}-1`,
);

const pids = new Map<string, number>();
for (const n of names) {
  try {
    const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Pid}}', n]);
    pids.set(n, Number(stdout.trim()));
  } catch {
    /* container not running */
  }
}

const toMiB = (s: string): number => {
  const m = /^([\d.]+)\s*([KMG]i?B)/i.exec(s.trim());
  if (!m) return NaN;
  const v = Number(m[1]);
  const unit = (m[2] as string).toLowerCase();
  return unit.startsWith('g') ? v * 1024 : unit.startsWith('k') ? v / 1024 : v;
};
const rssMiB = (pid: number | undefined): number => {
  if (!pid) return NaN;
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) / 1024 : NaN;
  } catch {
    return NaN;
  }
};

writeFileSync(out, 'time_s,container,cpu_pct,mem_mib,rss_mib,host_load1\n');
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  const tick = Date.now();
  try {
    const { stdout } = await run('docker', [
      'stats',
      '--no-stream',
      '--format',
      '{{.Name}},{{.CPUPerc}},{{.MemUsage}}',
      ...names,
    ]);
    const load1 = readFileSync('/proc/loadavg', 'utf8').split(' ')[0];
    const t = ((Date.now() - t0) / 1000).toFixed(1);
    for (const line of stdout.trim().split('\n')) {
      const [name, cpu, mem] = line.split(',');
      if (!name) continue;
      const pid = pids.get(name);
      const rss = name.includes('-app') ? rssMiB(pid) : NaN;
      appendFileSync(
        out,
        `${t},${name.replace('harmony-load-', '').replace('-1', '')},${cpu?.replace('%', '')},${toMiB((mem ?? '').split('/')[0] ?? '').toFixed(1)},${Number.isNaN(rss) ? '' : rss.toFixed(1)},${load1}\n`,
      );
    }
  } catch (err) {
    console.error('sample failed', String(err).slice(0, 100));
  }
  const wait = interval * 1000 - (Date.now() - tick);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
