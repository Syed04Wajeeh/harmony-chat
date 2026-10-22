// Fills the first channel of a world with N messages through the REST API so the history scenario
// pages through a realistic backlog.
//   node loadtest/scripts/seed-history.ts --world loadtest/.work/world-hist.json --count 5000
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { api, loginFor, pool } from './lib.ts';

const { values } = parseArgs({
  options: { world: { type: 'string' }, count: { type: 'string', default: '5000' } },
});
if (!values.world) throw new Error('--world is required');
const world = JSON.parse(readFileSync(values.world, 'utf8')) as {
  prefix: string;
  members: number;
  channelIds: string[];
};
const channelId = world.channelIds[0] as string;
const owner = loginFor(world.prefix, 0);
const started = Date.now();
const n = Number(values.count);
await pool(
  Array.from({ length: n }, (_, i) => i),
  8,
  async (i) => {
    await api(owner, 'POST', `/api/channels/${channelId}/messages`, {
      content: `seed message ${i}: the quick brown fox jumps over the lazy dog`,
    });
  },
);
console.log(
  `seeded ${n} messages into channel ${channelId} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
