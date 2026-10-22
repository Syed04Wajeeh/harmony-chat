// REST history pagination: GET /api/channels/:id/messages, newest page then two older pages via
// `before`, from VUS concurrent members of one seeded channel (see loadtest/scripts/seed-history.ts).
//
//   WORLD=/work/world-hist.json VUS=50 DURATION=30s k6 run history.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';
import { BASE, authHeaders, loginFor, readWorld } from './lib.js';

const world = readWorld();
const VUS = Number(__ENV.VUS || 50);
const LIMIT = Number(__ENV.LIMIT || 50);
const pages = new Counter('pages_fetched');

export const options = {
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    history: { executor: 'constant-vus', vus: VUS, duration: __ENV.DURATION || '30s' },
  },
};

export default function () {
  const channelId = world.channelIds[0];
  // Member 0 owns the guild; members 1..members-1 read.
  const member = 1 + (exec.vu.idInTest % (world.members - 1));
  const headers = authHeaders(loginFor(world.prefix, member));
  let before = '';
  for (let page = 0; page < 3; page++) {
    const res = http.get(
      `${BASE}/api/channels/${channelId}/messages?limit=${LIMIT}${before ? `&before=${before}` : ''}`,
      { headers, tags: { name: 'history' } },
    );
    if (!check(res, { 'status 200': (r) => r.status === 200 })) return;
    pages.add(1);
    const body = res.json();
    if (!body.hasMore || body.messages.length === 0) return;
    before = body.messages[0].id;
  }
}
