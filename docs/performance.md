# Performance and horizontal scaling

How Harmony behaves under load and with two app instances, measured on one shared home server
against an isolated copy of the stack (`harmony-load`). Every number is from a run whose raw output
is in [`loadtest/results/`](../loadtest/results). Runs are dated 2026-10-22, except the presence
section (2026-10-23). Nothing is extrapolated. Architecture context:
[README](../README.md#architecture); design decisions: [NOTES.md](../NOTES.md).

## What was tested

Two identical app instances (`app1`, `app2`) behind nginx with `least_conn`, one Postgres, one
Redis and the outbox worker. The questions:

1. Does a message sent through one instance reach a client on the other, exactly once?
2. What happens to connected clients when an instance dies mid-stream, and when it comes back?
3. How many idle WebSocket connections fit, how fast is fan-out, how fast is REST history?
4. Do two instances perform better than one on this host?

## Environment

| Item           | Value                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host           | AMD Ryzen 5 3600X (6 cores, 12 threads), 15.4 GiB RAM, NVMe, Linux 7.0                                                                                                       |
| Docker         | 29.7.2, cgroup v2                                                                                                                                                            |
| Shared         | The host also runs about 25 unrelated containers. Idle load average before each run was 0.2 to 2.6 (the run scripts refuse to start above 6, or with under 2.5 GB available) |
| App            | Node 24.19 (alpine image), Fastify 5, `pg` pool of 10 per instance                                                                                                           |
| Data stores    | `postgres:16-alpine` defaults (fsync on), `redis:7-alpine` without persistence                                                                                               |
| Proxy          | `nginx:1.27-alpine` (1.27.5) running the production `common.conf` and `user.conf.template`                                                                                   |
| Load generator | `grafana/k6:1.3.0`, `--network host`, capped at 3 CPUs; Node 24 scripts for the functional tests                                                                             |

CPU caps (compose `cpus`): app1 2, app2 2, postgres 2, redis 1, nginx 1, worker 1, k6 3. Memory
limits: apps 2 GiB, postgres 2 GiB, redis and nginx 1 GiB. All ports are bound to 127.0.0.1.
Logging was at `warn` in the load stack, not the production default `info`.

Raised limits in the load stack, through env only: `RATE_LIMIT_MAX`, `MESSAGE_RATE_MAX`,
`REACTION_RATE_MAX`, `WS_FRAME_BURST`, `WS_FRAME_REFILL_PER_SECOND`.

## Method and deviations from production

- **Identity.** Tailscale Serve is bypassed: load clients send `Tailscale-User-Login:
load-<prefix>-<n>@example.com` and the right `Origin` to the load stack's nginx, which is the
  production user proxy and stamps the proxy secret exactly as in production. Serve is a TLS
  terminator on the same host and would only add its own CPU cost; its identity headers are what
  the clients send. There is no TLS anywhere in the measured path.
- **k6 runs on the same host** as the system under test and competes for the same cores and
  memory bandwidth. Caps limit that, they do not remove it.
- **Latency** is send to receive on another client: each message carries `Date.now()` in its
  content and the receiving k6 VU subtracts it. k6 and the server share one clock. It includes the
  REST request, the Postgres transaction, the Redis publish and the WebSocket push.
- **Setup** is done through the REST API (create guilds, invites, accept). The connection-capacity
  world (10,000 users) was created on an empty database, because of the query issue under "Findings
  not fixed".
- Each fan-out run: 200 receivers (20 channels, 10 receivers each, spread over both instances by
  nginx), 5 s warm-up, 30 s of sending at a constant arrival rate, 8 s drain. Every message is
  delivered to 10 sockets, so "delivered/s" is ten times the send rate.

## Results

### Cross-instance delivery (live containers)

`loadtest/scripts/cross-instance.ts`: client A pinned to app1 (instanceId `app-1`), client B pinned
to app2 (`app-2`) through two load-only nginx listeners. 1,000 messages, 500 sent by each,
alternating, both subscribed.

| Check                                 | A (app-1)     | B (app-2)     |
| ------------------------------------- | ------------- | ------------- |
| Received                              | 1000          | 1000          |
| Duplicates                            | 0             | 0             |
| Missing vs database                   | 0             | 0             |
| Cross-instance latency p50 / p95 (ms) | B to A: 3 / 5 | A to B: 3 / 5 |

All 1,000 messages were acknowledged and persisted. 60 connections opened through the balanced
listener split 30 on each instance (least_conn). Raw: `2026-10-22-cross-instance.json`.

### Failover

`loadtest/scripts/failover.ts`: 20 receivers (10 on each instance at start) through the balanced
listener, 4 concurrent REST senders at about 100 messages/s in total for 40 s, `docker kill` of
app1 at t=10 s, `docker start` at t=25 s. Receivers reconnect with the web client's backoff
(250 to 500 ms for the first attempt), resubscribe with `lastSeenId`, and if the server answers
`hasMore: true` page the gap over REST as the protocol says. At the end each receiver's set of
message ids is compared with the database.

| Run set                                             | Runs                                                       | Lost messages (all receivers) | Reconnect, close to hello                                               | Notes                                       |
| --------------------------------------------------- | ---------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| `proxy_connect_timeout 2s`, no `resolve`            | 3 (one lost messages through a test-client bug, see below) | 0 in the 2 valid runs         | p50 2262 ms and 339 ms                                                  | the third run's p50 was 441 ms, max 2505 ms |
| `proxy_connect_timeout 1s`, no `resolve`            | 7 (the first 4 with an earlier version of the test client) | 0                             | p50 317, 330, 359 ms in the fast runs, 1269 to 1327 ms in the slow runs | bimodal                                     |
| with `resolve`                                      | 2                                                          | 0                             | p50 454 and 413 ms, max 499 ms                                          | final configuration                         |
| forced gap over one backfill page (3 s extra delay) | 2                                                          | 0                             | p50 4278 and 3319 ms (includes the 3 s delay)                           | exercises `hasMore`                         |

What happened in a typical run (10 clients were on app1): the connection closes about 45 ms after
the kill, all 10 reconnect to app2, 0 failed connect attempts, backfill 30 to 250 messages per
client, 0 to 5 raw duplicates per run (live and backfill overlap, deduplicated by id), every
persisted message received exactly once. REST senders see one to three `502`s in the instant of the
kill (requests already sent to the dying instance are not retried by nginx: POST is not
idempotent). Each is a failed send the client knows about, and none of them was persisted.

Two things were learned along the way:

- **Dead container black hole.** After `docker kill` the container's address no longer answers, so
  nginx waits out `proxy_connect_timeout` before trying the other server. With the 60 s default
  that would be a minute. At 2 s, nearly all clients waited the full 2 s (p50 2262 ms). At 1 s the
  result was bimodal across runs: about 0.3 s when the connect failed at once, about 1.3 s when it
  hit the timeout. 1 s is kept; connecting inside a Docker network takes well under a millisecond
  unless the target is gone.
- **My first test client lost messages (a bug in the test, not the server).** In one run two
  clients missed 36 and 49 consecutive messages. After a 2.5 s outage the gap exceeded one backfill
  page (200), the answer carried `hasMore: true`, and the script re-subscribed with the highest id
  it had seen, which already included live messages that arrived meanwhile, so it skipped the
  middle of the gap. The documented contract is to reload over REST on `hasMore`; the script now
  does that. The faulty run is kept as `...connect2s-run3-testclient-cursor-bug.json`. A related
  theoretical risk was not observed: ids are assigned at insert, commits can interleave, so a
  client that disconnects in the few milliseconds between two commits could resume past an id that
  was published late.

#### Recreating an instance on a new IP

`loadtest/scripts/recreate.ts` replaces app1 with a new container on a different address (a filler
container holds the old one) while probing REST and WebSocket connects every 150 ms. Before the
upstream used `resolve`, nginx resolved `app1` once at startup and answered 502 for it until it
was restarted (this happened for real on the live stack). With `resolver 127.0.0.11 valid=10s` and
`server app1:8080 resolve`, nginx was never restarted and the address changed:
85 of 85 REST probes returned 200, 0 WebSocket connect failures, and the first connection to the
new app1 arrived 4.3 s after it became healthy (DNS re-resolution interval plus least_conn
bookkeeping). Raw: `2026-10-22-recreate-new-ip.json`.

### Fan-out latency (the headline)

Highest tested send rate with p95 under 100 ms, zero send errors and zero missed deliveries
(10 receivers per message, k6 capped at 3 CPUs, apps 2 CPUs each, Postgres 2 CPUs):

|               | Before optimization                       | After optimization                          |
| ------------- | ----------------------------------------- | ------------------------------------------- |
| Two instances | 500 msg/s (4,993 deliveries/s), p95 10 ms | 900 msg/s (8,988 deliveries/s), p95 9 ms    |
| One instance  | 500 msg/s (5,000 deliveries/s), p95 8 ms  | 1,000 msg/s (9,992 deliveries/s), p95 36 ms |

"Tested" matters: the sweeps used rates 100, 250, 500, 750, 1000, 1500, 2000 (plus 900 for the
final code), so the true ceiling lies between a passing and the next failing rate.

Full sweep, two instances, **after** (zero errors and zero missing deliveries in every row):

| Target msg/s | Achieved msg/s | Delivered/s | p50 ms | p95 ms | p99 ms | Max ms |
| ------------ | -------------- | ----------- | ------ | ------ | ------ | ------ |
| 100          | 100            | 1,000       | 5      | 6      | 8      | 36     |
| 250          | 250            | 2,500       | 5      | 12     | 24     | 162    |
| 500          | 500            | 5,000       | 4      | 6      | 8      | 27     |
| 750          | 749            | 7,492       | 4      | 6      | 17     | 127    |
| 900          | 899            | 8,988       | 4      | 9      | 39     | 160    |
| 1000         | 997            | 9,966       | 6      | 104    | 117    | 182    |
| 1500         | 1,009          | 10,092      | 995    | 1,051  | 1,324  | 1,532  |
| 2000         | 1,023          | 10,234      | 996    | 1,063  | 1,317  | 1,615  |

Full sweep, two instances, **before** (zero errors, zero missing deliveries; saturated from 750):

| Target msg/s | Achieved msg/s | Delivered/s | p50 ms | p95 ms | p99 ms | Max ms |
| ------------ | -------------- | ----------- | ------ | ------ | ------ | ------ |
| 100          | 100            | 1,000       | 6      | 8      | 10     | 42     |
| 250          | 250            | 2,500       | 6      | 8      | 9      | 34     |
| 500          | 499            | 4,993       | 5      | 10     | 54     | 161    |
| 750          | 698            | 6,976       | 864    | 1,509  | 1,580  | 1,639  |
| 1000         | 698            | 6,980       | 1,455  | 1,651  | 1,898  | 2,749  |
| 1500         | 690            | 6,901       | 1,494  | 1,606  | 1,674  | 2,396  |

Past the ceiling the system does not drop or error: the send request queues (the `POST` latency
equals the delivery latency, for example 1.4 s), the achieved rate flattens at the ceiling, and no
message is lost. At 2,000 target msg/s the achieved rate was 1,023.

### One instance versus two

Same caps per instance (2 CPUs), same load, same code (after):

| Target msg/s | 1 instance: achieved, p95 | 2 instances: achieved, p95 |
| ------------ | ------------------------- | -------------------------- |
| 250          | 250, 6 ms                 | 250, 12 ms                 |
| 500          | 500, 5 ms                 | 500, 6 ms                  |
| 750          | 750, 7 ms                 | 749, 6 ms                  |
| 1000         | 999, 36 ms                | 997, 104 ms                |
| 1250 / 1500  | 1,017, 1,034 ms           | 1,009, 1,051 ms            |

And before the optimization: one instance 659 msg/s achieved at a 750 target (p95 1,588 ms), two
instances 698 (p95 1,509 ms).

**Two instances did not raise throughput on this host, and at 1,000 msg/s the single instance was
better (p95 36 ms against 104 ms; one pair of runs, so treat the gap as indicative).** The reason
is in the CPU samples: at 1,000 msg/s each app instance used 60 to 80 % of one CPU (cap 2) while
Postgres used 130 to 170 % of its 2 CPUs. Every message is a transaction on the single Postgres, so
the shared database, not the Node processes, sets the ceiling; extra app instances add database
connections without adding database capacity. Scaling the app tier is meaningful for connection
count and for failover (below), not for this write ceiling. A larger Postgres allowance, or fewer
statements per message, is what raises it, which is what the optimization did.

### Connection capacity

`loadtest/k6/connections.js`: distinct authenticated users, each subscribing to one channel,
100 per guild. One k6 VU opens many sockets (100 VUs). Stops early when more than 1 % of attempts
fail. Memory is the instance's RSS (`/proc/<pid>/status`) sampled every 2 s; "idle" is the first
samples of the run.

| Target | Ramp / hold | Ready                      | Failed attempts             | Handshake p50 / p95 | Subscribe confirmed p50 / p95 | App RSS idle, plateau (each instance)     |
| ------ | ----------- | -------------------------- | --------------------------- | ------------------- | ----------------------------- | ----------------------------------------- |
| 2,000  | 60 s / 30 s | 2,000 (1,000 per instance) | 0 %                         | 4 ms / 78 ms        | 26 ms / 179 ms                | 179 to 185 MiB (about +4 MiB)             |
| 5,000  | 90 s / 30 s | 4,958                      | 0.82 %                      | 949 ms / 8.6 s      | 1.8 s / 20.5 s                | 185 to 198-203 MiB (about +13 to +17 MiB) |
| 10,000 | 120 s       | 4,151 when k6 aborted      | 1.36 % (over the 1 % limit) | 890 ms / 16.6 s     | 2.2 s / 18.5 s                | 144 to 201 MiB                            |

Peak established client connections seen at nginx (sampled every 3 s): 2,000, 4,706 and 5,605.
The 10,000 target was **not reached**: k6 stopped the run when failures crossed 1 %. 5,000 was
almost reached (4,958 ready, 42 failed), and 2,000 was clean.

Memory per connection: from the RSS growth, about 4 to 6 KiB per connection per instance
(2,000 run: +4 MiB over 1,000 connections; 5,000 run: +13 to +17 MiB over about 2,500). That is
small relative to the 150 to 200 MiB the process holds anyway, the idle baselines include heap left
from earlier setup traffic, and RSS rises in steps, so read it as "a few KiB, well under 10", not as
a precise constant. The cgroup figure (which includes socket buffers) grew about 10 KiB per
connection in the 5,000 run (135 to 161 MiB).

**Why it stops around 5,000.** Presence is broadcast to every connected socket. Each user who comes
online sends one `presence.updated` frame to everyone, so connecting N users delivers about N²/2
frames: k6 received 2,001,496 such frames at 2,000 connections and 20,840,511 at 5,000. In the
5,000 run nginx averaged 98 % of its 1-CPU cap and peaked at 106 %, and the apps averaged about 84 %
of one CPU with peaks of 115 %, so handshakes and subscriptions queued behind presence traffic
(handshake p95 8.6 s). In practice, with real users trickling in rather than a 90 s ramp, the load
is lower, but the quadratic shape is real and is the first thing to change if this ever has to
hold thousands of simultaneous users: scope presence to guild members instead of everyone. This
was measured, not fixed here; see "Scoped and batched presence" for the fix and its results.

### REST history

`GET /api/channels/:id/messages?limit=50` then two older pages via `before`, from a channel with
5,000 messages, members of one guild, 20 s per level, through the balanced listener (both
instances).

| Concurrency (VUs) | Requests/s | p50 ms | p95 ms | p99 ms | Failed |
| ----------------- | ---------- | ------ | ------ | ------ | ------ |
| 10                | 994        | 6.3    | 38.4   | 44.5   | 0      |
| 50                | 1,006      | 43.6   | 71.8   | 75.8   | 0      |
| 200               | 1,005      | 198.2  | 213.8  | 247.2  | 0      |

Throughput flattens at about 1,000 requests/s regardless of concurrency; a sampled run at 50 VUs
showed Postgres at about 162 % of its 2-CPU cap and each app at 63 %, so history reads are also
bound by Postgres, and latency beyond the knee is queueing.

## Re-check after the module system

The module system adds nothing to the send path by construction (see [modules.md](modules.md), "Hot-path
guarantees"), and an integration test asserts that a send issues the same 6 SQL statements with
and without the shipped modules. To confirm that in a real run, the fan-out scenario was repeated once
at the highest rate that passed before, on a freshly built temporary `harmony-load` stack (same
compose file, caps and scripts; the host load average was 1.3 and 9.1 GB were available):

| Run                              | Target msg/s | Achieved | Delivered/s | Errors | Missing | p50 ms | p95 ms | p99 ms | Max ms |
| -------------------------------- | ------------ | -------- | ----------- | ------ | ------- | ------ | ------ | ------ | ------ |
| Recorded, after the optimization | 900          | 899      | 8,988       | 0      | 0       | 4      | 9      | 39     | 160    |
| After the module system          | 900          | 899.1    | 8,991       | 0      | 0       | 4      | 10     | 49     | 126    |

26,973 messages were sent and all 269,730 deliveries arrived. There is no regression at this
resolution: p50 and p95 are within a millisecond, and the p99 difference is the kind of spread seen between runs
of the same code. It is one run, on a shared host, so read a 10 ms difference as noise rather than as a
finding. Raw: `loadtest/results/2026-10-22-fanout-modules-two-900.k6.json`. The stack and its volumes were
removed afterwards.

## Scoped and batched presence

Date 2026-10-23. Same stack, caps, scripts and k6 runner as above. Raw files:
`loadtest/results/2026-10-23-*`.

### What changed

- **Scope.** A user's presence is published to one Redis topic per guild they are in
  (`harmony:presence:guild:<id>`) and one per DM (`harmony:presence:dm:<channelId>`, so both
  participants share it), and every socket is subscribed to the topics of its own user's guilds and
  DMs. Visibility is symmetric by construction. Why topics and not a per-event audience computed by
  every instance: a transition can be detected on an instance that does not host the user (a sweep
  after a crash, `PATCH /api/me` landing elsewhere), and a subscriber-side filter would then need
  the membership of users it has no sockets for. With topics the publisher needs the user's topic
  list and the subscriber needs only its own sockets' lists, and Redis does the filtering. The
  list is loaded with one query at connect (the query that replaced the status read the old
  announce did), then kept live from the per-user events the sockets already receive
  (`guild.joined`, `guild.removed`, DM `channel.joined`). No database query happens per presence event.
  Exceptions, both rare: a user whose sockets are not on the publishing instance (status change via
  REST on another instance, expiry after a crash) costs one membership query.
- **Shown status** moved from "read `users.status` at every announce" to a Redis hash
  (`harmony:presence:status`) changed in the same Lua step as the online set. Snapshots read it with
  `HMGET`, so `GET /api/presence` and the guild member list make no query for statuses.
- **Snapshots are scoped.** `GET /api/presence` lists the caller, the members of the caller's guilds
  (from the permission cache) and DM partners.
- **Batching.** Each instance coalesces presence per topic over `PRESENCE_BATCH_MS` (default 1000):
  last write wins per user, a user whose final state equals what the topic last sent is dropped
  (a flap sends nothing), and each socket in the topic gets one `presence.batch` frame with the
  serialized string shared by all sockets. State is per topic, not per socket, so a 10,000-member
  guild keeps one map, not 10,000. The `presence.updated` socket frame is gone (it stays as the
  internal Redis event).
- **Snapshot correctness.** `hello` is sent only after the socket joined its presence topics. The
  client fetches `GET /api/presence` after `hello`; batch updates that arrive while the fetch is in
  flight win over the fetched value. Joining or leaving a guild, or a new DM, triggers a refetch.

### Measurement

Methodology as in "Connection capacity" above (distinct authenticated users, 100 k6 VUs, one
channel each, ramp then 30 s hold, k6 aborts above 1 % failed attempts, two app instances behind
nginx with 1 CPU, apps 2 CPUs each). Differences from the earlier connection-capacity run, all of which apply equally to the
BEFORE and AFTER rows:

- k6 additionally counts presence frames and the user updates inside them, and fetches
  `GET /api/presence` three times during the hold as one user (the cost of a snapshot with everyone
  online). the earlier run did not make that request.
- The run script's watchdog limit was raised from a host load average of 12 to 16 (`WATCHDOG_LOAD`):
  the BEFORE 5,000 run was killed twice at 12.0 and 12.4 (4,100 to 4,200 sockets up, host load,
  not memory). The "load below 6 and 2.5 GB available" check before each run is unchanged.
- BEFORE is `main` at 96f15fe built in a temporary worktree; AFTER is this branch. Both images were
  built the same day with the same Dockerfile; each ran on a freshly created stack (volumes removed
  in between).

**World shapes.** Users are created through the REST API as before. Every new user is auto-joined
to the instance's default guild, which would make every world a single shared guild. Two shapes were
therefore measured:

- **Scoped world** (`loadtest/scripts/detach-default-guild.sql`): the 10,000 users removed from the
  default guild after setup, so each user is only in their own guild: 100 guilds of 100 members,
  nobody shares anything with anybody outside their guild. Apps restarted afterwards (guild
  membership is cached).
- **Giant-guild world** (nothing removed): all N connecting users are in one shared guild
  (the default one, up to 10,000 members) and also in their own 100-member guild. Scoping removes
  nothing here: everyone is a member of the same guild, so this is the worst case for scoping and
  isolates what batching alone does.

BEFORE on the giant-guild world and on the scoped world is the same code; it ignores guilds, so
differences between those two BEFORE sets are run-to-run variation (a measure of how much to trust
single runs).

Connected = k6 `conns_ready`. Failure rate = failed attempts / attempts. Handshake = WebSocket
open. CPU = `docker stats`, % of one core (nginx cap 100, apps cap 200), mean and max over the
ramp+hold. Presence frames/s and updates/s are totals divided by ramp+hold seconds, summed over all
sockets (what the clients received).

#### Scoped world (100 guilds of 100)

| Target | Build  | Connected          | Failed | Handshake p95 | Presence frames/s | Updates/s | nginx CPU avg/max | App CPU avg/max (each) | App RSS idle to peak |
| ------ | ------ | ------------------ | ------ | ------------- | ----------------- | --------- | ----------------- | ---------------------- | -------------------- |
| 2,000  | BEFORE | 2,000              | 0 %    | 107 ms        | 22,239            | 22,239    | 47 / 103          | 25 / 70                | 140 to 183 MiB       |
| 2,000  | AFTER  | 2,000              | 0 %    | 3 ms          | 579               | 1,138     | 4 / 23            | 7 / 45                 | 140 to 181 MiB       |
| 5,000  | BEFORE | 4,872              | 0.31 % | 6,698 ms      | 124,184           | 124,184   | 96 / 109          | 70 / 106               | 183 to 209 MiB       |
| 5,000  | AFTER  | 5,000              | 0 %    | 4 ms          | 1,460             | 2,118     | 9 / 54            | 10 / 82                | 181 to 197 MiB       |
| 10,000 | BEFORE | 5,151 (k6 aborted) | 1.00 % | 10,995 ms     | 96,328            | 96,328    | 97 / 107          | 73 / 103               | 112 to 200 MiB       |
| 10,000 | AFTER  | 10,000             | 0 %    | 29 ms         | 2,942             | 3,375     | 14 / 81           | 14 / 82                | 192 to 237 MiB       |

BEFORE at the 5,000 target ended with 4,887 of 5,000 attempts made and 15 failed (0.31 % overall); the
run stops early on the running failure rate and I did not check which instant tripped it. Peak established
sockets at nginx: BEFORE 4,592 (5,000) and 5,209 (10,000), AFTER 5,001 and 10,001. Subscribe
confirmed p95: BEFORE 21 s and 32 s, AFTER 9 ms and 34 ms. Updates/s is lower than frames/s x
batch size would suggest at low load because most windows carry few updates.

AFTER's app RSS grew 40 to 45 MiB per instance over 5,000 sockets each at 10,000 (192 to 232 MiB, 197 to 237 MiB).

Cost of one `GET /api/presence` with everyone online (user 0, mean of three requests during the
hold): BEFORE 30 ms and 71 KB at 2,000, 1,534 ms and 158 KB at about 4,500 online; AFTER 18 ms and
3.5 KB at 2,000 and 7 ms and 3.5 KB at 5,000 and 10,000 (it lists only the caller's 100 guild mates).
BEFORE's cost is the database `id in (...)` read of every online user.

#### Giant-guild world (honest worst case for scoping)

| Target | Build  | Connected          | Failed | Handshake p95 | Presence frames/s | Updates/s | MB received (ramp+hold) | nginx CPU avg/max | App CPU avg/max (each) |
| ------ | ------ | ------------------ | ------ | ------------- | ----------------- | --------- | ----------------------- | ----------------- | ---------------------- |
| 2,000  | BEFORE | 2,000              | 0 %    | 98 ms         | 22,239            | 22,239    | 121                     | 47 / 106          | 25 / 76                |
| 2,000  | AFTER  | 2,000              | 0 %    | 6 ms          | 1,248             | 23,753    | 80                      | 6 / 21            | 7 / 32                 |
| 5,000  | BEFORE | 4,176 (k6 aborted) | 1.09 % | 6,220 ms      | 85,087            | 85,086    | 622                     | 94 / 106          | 70 / 102               |
| 5,000  | AFTER  | 5,000              | 0 %    | 41 ms         | 3,188             | 107,529   | 476                     | 13 / 53           | 13 / 75                |
| 10,000 | BEFORE | 4,815 (k6 aborted) | 1.65 % | 9,011 ms      | 85,116            | 85,116    | 778                     | 98 / 109          | 76 / 104               |
| 10,000 | AFTER  | 10,000             | 0 %    | 225 ms        | 6,389             | 339,839   | 1,866                   | 21 / 97           | 19 / 120               |

Here the delivered work is the same or larger (every socket still needs everyone's presence: the
AFTER updates/s at 10,000 is 340,000 against BEFORE's 85,000, because AFTER got all 10,000 sockets
online and BEFORE only 4,800), but it arrives in 6,400 frames/s instead of 85,000, and that is what
nginx and the apps were spending their CPU on. Connection capacity went from about 4,200 to 5,000
to 10,000 with 0 failures even though nothing was scoped. The total bytes are higher at 10,000
(1.9 GB over 150 s) because the full 10,000-member state has to reach 10,000 sockets once
(about 50 million user updates); batching cannot reduce that, only the framing around it.
Cost of `GET /api/presence` here (everyone online): 35 ms and 359 KB at 10,000 sockets, AFTER.

The giant-guild BEFORE runs happened earlier the same day on the same code as the scoped-world
BEFORE runs: the 5,000 target connected 4,176 against 4,872, the 10,000 target 4,815 against
5,151. That is the run-to-run spread on this host; both fail the same way.

### Fan-out check (900 msg/s, two instances, 20 guilds x 11 users, 200 receivers, 30 s)

Zero send errors and zero missing deliveries in every run below (sent 26,900 to 26,960 messages, all
269,000+ deliveries arrived). Achieved 896.8 to 898.8 msg/s.

| Run                                                 | p50 ms | p90 ms  | p95 ms  | p99 ms   | Max ms    |
| --------------------------------------------------- | ------ | ------- | ------- | -------- | --------- |
| BEFORE, fresh stack, run 1                          | 5      | 8       | 17      | 59       | 217       |
| BEFORE, fresh stack, run 2                          | 4      | 29      | 58      | 108      | 178       |
| BEFORE, fresh stack, run 3                          | 4      | 35      | 67      | 99       | 151       |
| AFTER, fresh stack, run 1                           | 5      | 10      | 26      | 69       | 241       |
| AFTER, fresh stack, run 2                           | 4      | 34      | 61      | 93       | 144       |
| AFTER, fresh stack, run 3                           | 4      | 24      | 65      | 103      | 177       |
| BEFORE, after the 10k connection runs, runs 1 and 2 | 5 / 5  | 8 / 7   | 19 / 12 | 65 / 47  | 251 / 121 |
| AFTER, after the 10k connection runs, runs 1 and 2  | 5 / 4  | 44 / 10 | 67 / 65 | 104 / 97 | 174 / 134 |

My first AFTER run showed p95 67 ms against 9 to 13 ms recorded in earlier phases, which looked
like a regression. It was not reproduced as one: with the code swapped back, BEFORE on a fresh stack
gave 17, 58 and 67 ms in three consecutive runs and AFTER gave 26, 61 and 65. In both builds the
first run on a stack is the best and later runs have a 10 to 15 % tail; the same-day numbers are
worse than the 10 to 13 ms measured after the permissions fix for both builds, and Postgres sat at 165 to 166 % of its
2-CPU cap in the BEFORE and AFTER runs alike. I attribute the drift to the host (about 25 other
containers) and to the stack's state, but I did not find the cause. The conclusion I can support is
only that BEFORE and AFTER are indistinguishable at 900 msg/s with three runs each (p95 17 to 67 ms
against 26 to 65 ms); this phase does not touch the send path and the 6-statement send test passes.

### Unread counts: analysis only, not fixed

Measured in the BEFORE stack with 599,998 messages (`loadtest/scripts/seed-unread.sql`: the user's
channel has 1,000 early messages with the last 5 unread, and the other 598,998 messages are in
three busy channels, so every id after the user's read marker belongs to a different channel).

| Endpoint (user in 2 guilds, sequential, 40 requests after 5 warm-up) | p50    | p95    |
| -------------------------------------------------------------------- | ------ | ------ |
| `GET /api/guilds`                                                    | 221 ms | 227 ms |
| `GET /api/channels`                                                  | 217 ms | 220 ms |

With the same 600,000 rows spread over 99 channels the planner chose a bitmap scan on
`messages_channel_id_id_idx` and the endpoints took 16 and 8 ms, so the problem depends on the data
shape, not only on the row count: it needs a few dense channels (the planner's estimate for
`channel_id = c.id` is then a large fraction of the table and the primary key walk looks cheaper).

`EXPLAIN (ANALYZE, BUFFERS)` of the existing query: `Index Scan using messages_pkey` filtered by
channel, 23,908 buffer hits, 159.6 ms (`results/2026-10-23-unread-explain-old.txt`). Variants tried
on the same data, none changed the plan: the suggested `LATERAL` subquery with `ORDER BY m.id LIMIT
101` (159.4 ms), `ORDER BY m.channel_id DESC, m.id` (159.6 ms), `ORDER BY m.id` (165 ms) and
`ORDER BY m.id + 0` (a sort over the same primary-key scan, 162 ms). The planner keeps the primary key
range because the existing index is `(channel_id, id desc)` and fetching heap rows through it looks
random and expensive next to the correlated primary key.

A covering index `(channel_id, id) include (author_id, deleted_at)` gave an index-only scan and 22 ms
for the same query (`results/2026-10-23-unread-explain-covering-index.txt`; 28 MB on an 81 MB
table, 32 MB for the existing index). It was not implemented: it is a second index on `messages`,
which every send has to maintain (the 6-statement send path and the 900 msg/s result are what the
phase must not disturb, and the permissions regression below showed small costs there matter), it still walks every
row of a channel whose unread messages are mostly the reader's own, and it depends on the planner
agreeing. Nothing in the unread code was changed, so there is no AFTER number for it; I did not
re-measure the endpoints on the AFTER build.

Proposed design (not implemented, needs a migration): keep `channels.last_message_id` (updated in the
send statement that already exists) and add `channel_members.unread_count` plus
`mention_count`, incremented for every member in the send transaction's fan-out insert and reset by
`read`. Reads become `select` of two integers per channel with no scan; the cost moves to the send
path (an `update channel_members ... where channel_id = $1 and user_id <> $author` per message,
which is O(members) writes) and has to be measured against the 900 msg/s result, with the
decision that fan-out to a channel of thousands of members should use a lazy "last read vs
last message id" check first (a fully read channel then costs nothing).

### Limits of these results

One host, k6 on the same machine, Serve and TLS bypassed. One run per cell (the fan-out check has
three), and the two BEFORE worlds show 15 % differences in connected sockets for the same code.
BEFORE never reached 5,000 sockets at the 5,000 and 10,000 targets in any of the four attempts today
(the first connection-capacity run reached 4,958 at 0.82 %); I did not find the reason for the lower number, host load was 0.2
to 2 at the start of each run. Memory per socket was not re-derived. Presence latency is now up to
one batch window (1 s default) later than before; that was not measured end to end. Direct messages
were not part of the worlds (no DM topics were exercised under load); they are covered by the
integration tests only. The reproduce steps are the ones above plus
`WATCHDOG_LOAD=16 LABEL=<before|after> bash loadtest/scripts/run-conns.sh 10000 120 30`.

## Roles and permissions: a fan-out regression

In this section and in the raw file names, `5b` is the label of the roles-and-permissions branch.

**Symptom.** The first fan-out run after roles and permissions were added at a 900 msg/s target
achieved 749.5 msg/s with p50 1,344 ms and p95 1,415 ms (`2026-10-22-fanout-perms-two-900.k6.json`).
Before it the same scenario gave 899 msg/s and p95 9 to 10 ms. It was unknown whether that was real
or an artifact of how the world had been seeded.

**Same-day baseline.** Two images were built the same day: `main` (checked out in a temporary git
worktree, used only to build) and the 5b branch. Each run used a freshly created `harmony-load`
stack (same compose file, caps and scripts as above; two app instances, one worker), a world made
with `loadtest/scripts/setup.ts` through the REST API (20 guilds, 11 users each; not raw SQL),
200 receivers, 5 s warm-up, 30 s at 900/s, 8 s drain. Host load average at the start was 1.8 to
4.4 (guard: below 6) and at least 9 GB were available. Runs alternated between images.

| Run                      | Image            | Achieved msg/s | Delivered/s | Errors | Missing | p50 ms | p95 ms | p99 ms | Max ms | Postgres CPU p75 (cap 200 %) |
| ------------------------ | ---------------- | -------------- | ----------- | ------ | ------- | ------ | ------ | ------ | ------ | ---------------------------- |
| perms (earlier, one run) | 5b               | 749.5          | 7,495       | 0      | 0       | 1,344  | 1,415  | 1,447  | 1,478  | not kept                     |
| main r1                  | main             | 897.9          | 8,979       | 0      | 0       | 4      | 12     | 63     | 225    | 171                          |
| 5b r1                    | 5b, before fix   | 815.6          | 8,156       | 0      | 0       | 993    | 1,293  | 1,319  | 1,358  | 206                          |
| main r2                  | main             | 898.5          | 8,985       | 0      | 0       | 4      | 10     | 77     | 185    | 168                          |
| 5b r2                    | 5b, before fix   | 766.7          | 7,667       | 0      | 0       | 1,290  | 1,377  | 1,397  | 1,475  | 207                          |
| main r3                  | main             | 897.7          | 8,977       | 0      | 0       | 4      | 11     | 73     | 192    | 166                          |
| main r4                  | main             | 897.6          | 8,976       | 0      | 0       | 4      | 12     | 83     | 253    | 167                          |
| fix r1                   | 5b, with the fix | 897.9          | 8,979       | 0      | 0       | 4      | 11     | 77     | 280    | 170                          |
| main r5                  | main             | 897.8          | 8,978       | 0      | 0       | 4      | 10     | 61     | 235    | 166                          |
| fix r2                   | 5b, with the fix | 897.2          | 8,972       | 0      | 0       | 4      | 12     | 96     | 323    | 171                          |
| main r6                  | main             | 897.8          | 8,978       | 0      | 0       | 4      | 13     | 90     | 262    | 170                          |
| fix r3                   | 5b, with the fix | 898.1          | 8,981       | 0      | 0       | 4      | 11     | 74     | 248    | 170                          |

Raw files: `loadtest/results/2026-10-22-fanout-reg-<image>-r<n>-two-900.k6.json` and `.stats.csv`
(`<image>` is `main`, `5b` or `fix`). Main r3 and r4 ran between two attempts at the fix, which is
why their numbers are listed before the final fix runs. The first attempt at main r2 and 5b r2 produced no result files (the output was discarded, most likely
the host guard refusing a busy host) and both were repeated a few minutes later.

**The regression was real.** All ten 5b runs (the earlier one, r1, r2, and seven under the profiling
overlay: 741 to 796 msg/s) fell short of 900 msg/s with p50 near or above one second; all ten main
runs (the six above and four under the overlay) were at 897.6 to 898.5 msg/s with p95 10 to 13 ms
in the tabulated six. It was not the seed: the world here was built
through the API, as for main. Delivery stayed correct (0 missing, 0 errors); the loss is purely
capacity. The apps were not the limit (a V8 CPU profile of a 5b app instance under load was 68.8 %
idle, 4.1 % Kysely, 7.1 % socket `writev`), but Postgres was pinned at its 2-CPU cap (p75 206 to 207 %
against 166 to 171 % for main at a higher send rate).

**Cause, with evidence.**

1. `pg_stat_statements` (execution time only) for one 900/s run each, 5b against main: the same six
   statements per send, no extra ones (the permission cache was loaded 40 times for 20 guilds on
   two instances, i.e. never reloaded during the run), but every statement was slower on 5b: the
   `messages` insert 0.271 against 0.140 ms, the message re-read 0.182 against 0.049 ms, the
   outbox insert 0.074 against 0.030 ms. Because 5b was saturated, part of that is queueing for
   the CPU cap, so it only says that the database was doing more work per message, not where.
2. The only changed statement on the send path is the message re-read: 5b joined `channels` and
   `guild_members` into it to return the author's nickname. `EXPLAIN ANALYZE` shows a good plan
   (primary-key lookups, 0.29 ms execution), so the cost had to be elsewhere.
3. With `pg_stat_statements.track_planning` on, the same 5b run showed that statement at 1.361 ms
   mean planning time plus 0.308 ms execution, 37.2 s of the 55.2 s of tracked time in the run. The
   driver sends the query unprepared, so Postgres plans it on every send. Measured warm in one
   session (planning time of `EXPLAIN`, same message id, repeated): 0.35 ms with the two extra
   joins, 0.14 ms for the query as it was on main, 0.17 ms with the nickname as a scalar subquery.
   The first `EXPLAIN` in a new session costs about 3 ms because of cold catalog caches, so a single
   measurement overstates this; the repeated numbers are the ones used here.
4. Isolation test: an image identical to 5b except that the nickname column was a constant `null`
   reached 897.2 and 894.5 msg/s with p50 4 and 5 ms (raw files not kept). So the nickname lookup,
   and nothing else in 5b, was responsible. The 6-statement send test passed throughout, because the
   regression was in the statements' cost, not their number.

I did not add a temporary debug counter for permission cache loads; `pg_stat_statements` already
counts every load (40 for the whole run).

**What did not work.** Replacing the joins by a scalar subquery inside the same SQL statement
improved it but did not close it: 874.9 and 875.6 msg/s (p50 369 and 391 ms) with a join inside the
subquery, 887.4 and 889.9 msg/s (p50 222 and 135 ms, p95 341 and 271 ms) with the nested form.
Postgres stayed at about 207 % in both. Those raw files were not kept.

**Fix.** The message query is back to its main-branch shape (users and the reply parent only). The
nickname comes from the in-process permission cache, which already holds every member of a guild
for the permission checks: `PermissionService.nicknames` answers from it, and a nickname change calls
`perms.changed` so the guild is dropped on every instance. Inside a transaction the reader uses
`cachedNicknames`, which never waits (a miss gives no nickname rather than borrowing a second
pooled connection while holding one), and the service calls `warm(channelId)` first. The first
version of this fix did not do that and deadlocked the pool at load: 14 and 10 messages were
accepted in 30 s, with the first requests of each guild all waiting for a second connection while
holding the first. Security semantics are unchanged: nicknames are display data, and no permission
check was touched. An integration test checks that a changed nickname is on the next message.

**After.** Rows "fix r1" to "fix r3" above: 897.2 to 898.1 msg/s, p50 4 ms, p95 11 to 12 ms, p99
74 to 96 ms, 0 errors, 0 missing deliveries, Postgres at 170 to 171 % (p75), all within the spread of
the six main runs (897.6 to 898.5 msg/s, p95 10 to 13 ms, p99 61 to 90 ms, Postgres 166 to 171 %).

**Conditions and limits.** Same host, same caps, one run per stack; k6 shares the machine; the
host load average during runs ranged from 0.4 to 6.9 (the 5b r2 run saw 6.9 at its peak, which is
above the guard's start-of-run limit but the effect it measured, over 1,000 ms latency, repeated in
runs that started at 4 to 5). The nickname is read from a cache that is dropped within a Redis
round trip of a change, so a message sent on another instance in that gap can carry the previous
nickname. Every message list (history, search, pins) takes nicknames from the same cache; the search module
joins `channels` itself again, as it did before that branch.
Lesson: a change that looks free in `EXPLAIN ANALYZE` can still cost on a hot path through
planning; `track_planning` belongs in the profiling overlay, and any new join in the message
query needs a send-rate run.

## The bottleneck and the fix

**Data.** Fan-out saturated at about 700 msg/s with one or two instances while the app processes
were far from their CPU cap and Postgres sat at 130 to 170 % of 2 CPUs. A V8 CPU profile
(`node --cpu-prof`) of an app instance under load was 72 % idle; the largest app-side cost was
socket `writev`, not JSON or queries. `pg_stat_statements` over one 30 s run at a 1,000 msg/s
target (18,702 messages) showed, per message: the `messages` insert at 0.37 ms, the event
worker's fan-out query at 0.78 ms per call with 6,836 calls (it ran about once per 2.7 events
because every NOTIFY woke it), the outbox insert 0.13 ms, the message re-read 0.10 ms, the
membership check 0.07 ms, plus three small reads and a no-op mentions delete. A message was 12
statements in total, so round trips and per-statement overhead on a 2-CPU database dominated.
Stopping the worker in a diagnostic run raised throughput from about 660 to about 860 msg/s.
(Those runs used the profiling overlay `deploy/load/compose.profile.yml`, which adds overhead, so
their absolute numbers are not in the tables.)

**Changes** (commit "Cut Postgres round trips per message and serialize fan-out frames once"):

1. New messages no longer `DELETE` mention rows that cannot exist yet.
2. A freshly inserted message is read back with one query instead of four: it has no reactions,
   its mentions are the ones just inserted, and the attachment query runs only when attachments
   were given.
3. The outbox insert and `pg_notify` are one statement.
4. The event worker waits 50 ms after a NOTIFY (`WORKER_BATCH_WINDOW_MS`) so a burst becomes one
   fan-out pass instead of one pass per message.
5. The hub validates and serializes a channel or presence event once per Redis message, not once
   per socket.

Sends went from 12 statements to 6 (including the membership check). All 210 integration and the
unit tests still pass.

**Before and after** (identical conditions: same stack, caps and scripts; two instances; image
rebuilt in between; sweeps run back to back on the same day): highest tested rate with p95 under
100 ms: 500 to 900 msg/s; saturation ceiling about 698 to about 1,010 to 1,023 msg/s (+45 to 47 %).
At 750 msg/s: p95 1,509 ms before, 6 ms after. Single instance: ceiling 659 to about 1,017 msg/s.
I cannot attribute the gain between changes 1 to 5; only the combined effect was measured, plus the
worker-stopped diagnostic above.

## Findings not fixed

- **Unread counts scan the whole messages table** (analyzed again with the presence work, still not fixed). For a user whose channel has few unread
  messages, the `unread_count` subquery in `ChannelService.listForUser` is planned as a scan of
  `messages_pkey` filtered by channel (`id > last_read`), 568,623 buffer hits and 173 ms with 600,000
  rows in the table, and `GET /api/guilds` and `/api/channels` cost 170 to 350 ms each. `ORDER BY`
  rewrites did not change the plan, and `ANALYZE` did not either. It grows with total message
  count, not channel size. It does not affect sending or history, so it was left; the next step
  is a lateral subquery over `messages_channel_id_id_idx` or a maintained unread counter.
- Presence broadcast is quadratic (above): fixed (see "Scoped and batched presence").
- Stale-ID backfill ordering risk (above), not observed.

## Limitations

- One host, with 25 other containers running; k6 on the same machine; Serve bypassed; no TLS.
- Single measurements for most rates (the failover runs were repeated, the sweeps were not), so
  differences of a few milliseconds at low load are noise. The 1,000 msg/s p95 gap between one and
  two instances is one run each.
- Receivers per message is 10. Fan-out to hundreds of subscribers per channel was not measured.
- Logging at `warn`; production defaults to `info` and would cost more CPU.
- Postgres on defaults. Tuning (`synchronous_commit`, `shared_buffers`) would move the ceiling and
  was not tried.
- Message sizes are tiny (about 20 bytes of content).

## Reproduce

```sh
pnpm install
pnpm load:up                       # builds harmony-load-app:local, starts project harmony-load
node loadtest/scripts/cross-instance.ts
node loadtest/scripts/failover.ts  # kills and restarts harmony-load-app1-1
node loadtest/scripts/recreate.ts  # recreates app1 on a new IP
node loadtest/scripts/setup.ts --prefix fan --groups 20 --members 11 --out loadtest/.work/world-fan.json
bash loadtest/scripts/sweep.sh run two 100 500 1000     # fan-out, two instances
docker stop harmony-load-app2-1; bash loadtest/scripts/sweep.sh run one 500 1000   # one instance
node loadtest/scripts/setup.ts --prefix hist --groups 1 --members 101 --out loadtest/.work/world-hist.json
node loadtest/scripts/seed-history.ts --world loadtest/.work/world-hist.json --count 5000
bash loadtest/scripts/run-history.sh
node loadtest/scripts/setup.ts --prefix cap --groups 100 --members 100 --out loadtest/.work/world-cap.json
bash loadtest/scripts/run-conns.sh 5000 90 30
pnpm load:down                     # removes the stack, its volumes and its image
```

After `docker stop`/`start` of an app container the stack's nginx re-resolves addresses by itself;
the single-instance runs use the pinned listener on `:8571`. Run the scripts from the repository
root. Each heavy script checks the host (load average and available memory) first.
