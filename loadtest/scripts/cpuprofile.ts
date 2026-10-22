// Summarises a V8 .cpuprofile: self time by function (top N) and by file/area.
//   node loadtest/scripts/cpuprofile.ts <file.cpuprofile> [topN]
import { readFileSync } from 'node:fs';

interface Node {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface Profile {
  nodes: Node[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}
const [file, topArg] = process.argv.slice(2);
if (!file) throw new Error('usage: cpuprofile.ts <file.cpuprofile> [topN]');
const top = Number(topArg ?? 25);
const profile = JSON.parse(readFileSync(file, 'utf8')) as Profile;
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map<number, number>();
profile.samples.forEach((id, i) => {
  self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
});
const total = [...self.values()].reduce((a, b) => a + b, 0);
const agg = new Map<string, number>();
const area = new Map<string, number>();
for (const [id, us] of self) {
  const f = (byId.get(id) as Node).callFrame;
  const key = `${f.functionName || '(anonymous)'}  ${f.url.replace(/^.*node_modules\//, 'nm/').replace(/^.*\/apps\/server\//, '')}:${f.lineNumber + 1}`;
  agg.set(key, (agg.get(key) ?? 0) + us);
  const a =
    f.url === ''
      ? f.functionName || '(native)'
      : f.url.includes('node_modules')
        ? (f.url.match(
            /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/,
          )?.[1] ?? 'nm')
        : f.url.startsWith('node:')
          ? f.url
          : 'app code';
  area.set(a, (area.get(a) ?? 0) + us);
}
const pct = (us: number) => ((us / total) * 100).toFixed(1).padStart(5);
console.log(
  `profile ${file.split('/').pop()}: ${(total / 1e6).toFixed(1)}s sampled, ${((profile.endTime - profile.startTime) / 1e6).toFixed(1)}s wall`,
);
console.log('\nSelf time by area:');
for (const [k, v] of [...area].sort((a, b) => b[1] - a[1]).slice(0, 14))
  console.log(`${pct(v)}%  ${k}`);
console.log(`\nTop ${top} functions by self time:`);
for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, top))
  console.log(`${pct(v)}%  ${k}`);
