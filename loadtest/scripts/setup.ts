// Pre-creates users, guilds and channel membership through the REST API (via nginx), and writes
// the resulting layout to a JSON file that the k6 scripts read.
//   node loadtest/scripts/setup.ts --prefix fan --groups 20 --members 21 --out loadtest/.work/world-fan.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { buildWorld } from './lib.ts';

const { values } = parseArgs({
  options: {
    prefix: { type: 'string' },
    groups: { type: 'string', default: '1' },
    members: { type: 'string', default: '2' },
    out: { type: 'string' },
    concurrency: { type: 'string', default: '16' },
  },
});
if (!values.prefix || !values.out) throw new Error('--prefix and --out are required');

const started = Date.now();
const world = await buildWorld({
  prefix: values.prefix,
  groups: Number(values.groups),
  members: Number(values.members),
  concurrency: Number(values.concurrency),
});
mkdirSync(dirname(values.out), { recursive: true });
// Compact: logins are `load-<prefix>-<n>@example.com` with n = group * members + member, so k6
// derives them; member 0 of each group owns the guild and is the sender.
const compact = {
  prefix: world.prefix,
  members: Number(values.members),
  channelIds: world.groups.map((g) => g.channelId),
};
writeFileSync(values.out, JSON.stringify(compact));
console.log(
  `world ${values.prefix}: ${world.groups.length} guilds x ${values.members} users in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${values.out}`,
);
