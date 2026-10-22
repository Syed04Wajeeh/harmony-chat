# Performance and horizontal scaling

Everything here was measured on one shared home server against an isolated copy of the stack
(`harmony-load`). Every number is from a run whose raw output is in
[`loadtest/results/`](../loadtest/results). Dates are 2026-10-22. Nothing is extrapolated.

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
`server app1:8080 resolve`, nginx was never restarted and the address changed from 172.22.0.6 to 172.22.0.8:
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
was measured, not fixed.

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

## Re-check after the module system (Phase 5a)

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

- **Unread counts scan the whole messages table.** For a user whose channel has few unread
  messages, the `unread_count` subquery in `ChannelService.listForUser` is planned as a scan of
  `messages_pkey` filtered by channel (`id > last_read`), 568,623 buffer hits and 173 ms with 600,000
  rows in the table, and `GET /api/guilds` and `/api/channels` cost 170 to 350 ms each. `ORDER BY`
  rewrites did not change the plan, and `ANALYZE` did not either. It grows with total message
  count, not channel size. It does not affect sending or history, so it was left; the next step
  is a lateral subquery over `messages_channel_id_id_idx` or a maintained unread counter.
- Presence broadcast is quadratic (above).
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
