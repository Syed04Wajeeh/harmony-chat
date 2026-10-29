import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import type { InteractionPayload, PanelView } from '@harmony/shared';
import { verifySignature } from '@harmony/shared/signature';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const API = process.env.HARMONY_URL ?? 'http://127.0.0.1:8471';
const TOKEN = need('HARMONY_BOT_TOKEN'); // hb_<botId>_<secret>, shown once when the bot is created
// HARMONY_MODE=gateway needs no URL and no signing secret: the bot connects out and Harmony
// sends interactions and events over that WebSocket. The default (http) listens on PORT.
const GATEWAY = process.env.HARMONY_MODE === 'gateway';
const SECRET = GATEWAY ? '' : need('HARMONY_SIGNING_SECRET'); // hsk_..., shown once as well
const GUILD_ID = need('HARMONY_GUILD_ID');
const PORT = Number(process.env.PORT ?? 4000);
const BOT_ID = TOKEN.split('_')[1];
// Optional: a dashboard (or any) channel to publish the demo panel into. Needs the panels.write scope.
const DASHBOARD_CHANNEL_ID = process.env.HARMONY_DASHBOARD_CHANNEL_ID;
const PANEL_INTERVAL_MS = Number(process.env.HARMONY_PANEL_INTERVAL_MS ?? 5000);

async function harmony(path: string, method: string, body: unknown, bot = true) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(bot && { authorization: `Bot ${TOKEN}` }) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
}

// Bulk overwrite: after this call the bot's commands in the guild are exactly these two.
await harmony(`/api/bots/${BOT_ID}/guilds/${GUILD_ID}/commands`, 'PUT', [
  {
    name: 'echo',
    description: 'Repeat text back, visible only to you',
    options: [{ name: 'text', description: 'What to say', type: 'string', required: true }],
  },
  {
    name: 'roll',
    description: 'Roll a die (answers after a short delay)',
    options: [{ name: 'sides', description: 'Number of sides', type: 'integer' }],
  },
]);

/* A demo dashboard: made-up host numbers, a live chart and two buttons. */

const wander = (value: number, step: number, min = 2, max = 98) =>
  Math.min(max, Math.max(min, value + (Math.random() - 0.5) * step));
let cpu = 35;
let memory = 58;
let restarts = 0;

const hostView = (history: { x: string; cpu: number; memory: number }[]): PanelView => ({
  title: 'Demo host',
  blocks: [
    {
      type: 'stat',
      label: 'CPU',
      value: Math.round(cpu),
      unit: '%',
      tone: cpu > 80 ? 'bad' : 'good',
    },
    {
      type: 'stat',
      label: 'Memory',
      value: Math.round(memory),
      unit: '%',
      tone: memory > 85 ? 'warn' : 'neutral',
    },
    {
      type: 'chart',
      id: 'load',
      title: 'Load',
      span: 'full',
      kind: 'area',
      yUnit: '%',
      yMin: 0,
      yMax: 100,
      series: [
        { name: 'cpu', points: history.map((h) => ({ x: h.x, y: Math.round(h.cpu) })) },
        { name: 'memory', points: history.map((h) => ({ x: h.x, y: Math.round(h.memory) })) },
      ],
    },
    {
      type: 'status',
      title: 'Services',
      items: [
        { label: 'Database', state: 'ok', detail: 'accepting connections' },
        { label: 'Backups', state: 'warn', detail: 'last run 26 hours ago' },
        { label: 'Mail relay', state: 'off' },
      ],
    },
    { type: 'progress', label: 'Disk', value: 412, max: 512, tone: 'warn' },
    {
      type: 'actions',
      buttons: [
        { id: 'refresh', label: 'Refresh', style: 'secondary' },
        {
          id: 'restart',
          label: 'Restart service',
          style: 'danger',
          confirm: {
            title: 'Restart the demo service?',
            body: 'Nothing real happens; this only shows the confirmation flow.',
            confirmLabel: 'Restart',
          },
          requiredPermission: 'manage_messages',
        },
      ],
    },
  ],
});

const seed = () => {
  const now = Date.now();
  return Array.from({ length: 24 }, (_, i) => {
    cpu = wander(cpu, 18);
    memory = wander(memory, 6);
    return {
      x: new Date(now - (24 - i) * PANEL_INTERVAL_MS * 6).toISOString(),
      cpu,
      memory,
    };
  });
};

if (DASHBOARD_CHANNEL_ID) {
  const base = `/api/channels/${DASHBOARD_CHANNEL_ID}/panels/host`;
  await harmony(base, 'PUT', { view: hostView(seed()), pinned: false });
  // Live updates append points instead of resending the whole view.
  setInterval(() => {
    cpu = wander(cpu, 18);
    memory = wander(memory, 6);
    const x = new Date().toISOString();
    harmony(`${base}/points`, 'POST', {
      blockId: 'load',
      series: 'cpu',
      points: [{ x, y: Math.round(cpu) }],
    })
      .then(() =>
        harmony(`${base}/points`, 'POST', {
          blockId: 'load',
          series: 'memory',
          points: [{ x, y: Math.round(memory) }],
        }),
      )
      .catch(console.error);
  }, PANEL_INTERVAL_MS).unref();
}

type Answer = Record<string, unknown>;

/** The bot's logic, independent of how the interaction arrived. */
function answer(interaction: InteractionPayload): Answer {
  if (interaction.type === 'action') {
    // A button was clicked. Harmony already checked the user may see the channel and holds the
    // button's requiredPermission; answer like a command, or replace the panel itself.
    if (interaction.action.id === 'restart') {
      restarts++;
      return {
        type: 'message',
        content: `Restarted (${String(restarts)} so far), asked by ${interaction.user.displayName}.`,
        ephemeral: true,
      };
    }
    cpu = wander(cpu, 18);
    return { type: 'update_panel', view: hostView(seed()) };
  }

  const { name, options } = interaction.command;
  if (name === 'echo') {
    return { type: 'message', content: String(options.text), ephemeral: true };
  }
  // Deferred: answer within 3 seconds, then post the real message within 15 minutes.
  setTimeout(() => {
    const roll = 1 + Math.floor(Math.random() * Number(options.sides ?? 6));
    const path = `/api/interactions/${interaction.id}/${interaction.token}/followup`;
    harmony(path, 'POST', { content: `You rolled a ${roll}` }, false).catch(console.error);
  }, 1000);
  return { type: 'deferred' };
}

if (GATEWAY) {
  runGateway();
} else {
  createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      // Always verify the signature over the raw body before trusting anything in it.
      const valid = verifySignature({
        secret: SECRET,
        timestamp: req.headers['x-harmony-timestamp'] as string | undefined,
        signature: req.headers['x-harmony-signature'] as string | undefined,
        body: raw,
      });
      if (!valid) return void res.writeHead(401).end();

      if (req.url === '/events') {
        // Deliveries are at-least-once: dedupe on this header if handling is not idempotent.
        const { type } = JSON.parse(raw) as { type: string };
        console.log('event', type, req.headers['x-harmony-delivery-id']);
        return void res.writeHead(204).end();
      }

      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(answer(JSON.parse(raw) as InteractionPayload)));
    });
  }).listen(PORT, () => console.log(`echo bot listening on :${PORT}`));
}

/**
 * Gateway mode: one outgoing WebSocket carries everything. Frames from Harmony:
 *   interaction.create  { interaction }   answer with interaction.respond
 *   event               { seq, event }    handle, then event.ack { seq }
 * After every (re)connect the bot sends resume { lastSeq }; Harmony acknowledges everything up to
 * that number and replays the rest, so events missed while offline are not lost. Delivery is at
 * least once: a seq at or below the last one handled is a repeat and is skipped.
 */
function runGateway(): void {
  const SEQ_FILE = process.env.HARMONY_SEQ_FILE; // optional: lets resume survive a restart
  let lastSeq = 0;
  try {
    if (SEQ_FILE) lastSeq = Number(readFileSync(SEQ_FILE, 'utf8')) || 0;
  } catch {
    // first run
  }
  let delayMs = 1000;

  const connect = () => {
    const url = `${API.replace(/^http/, 'ws')}/api/ws`;
    // Node's built-in WebSocket accepts a headers option, which the Bot credential needs.
    const ws = new (
      WebSocket as unknown as new (
        url: string,
        options: { headers: Record<string, string> },
      ) => WebSocket
    )(url, { headers: { authorization: `Bot ${TOKEN}` } });
    const send = (frame: unknown) => ws.send(JSON.stringify(frame));

    ws.addEventListener('message', (message) => {
      const frame = JSON.parse(String(message.data)) as { type: string; [key: string]: unknown };
      if (frame.type === 'hello') {
        delayMs = 1000;
        console.log('connected to the gateway; resuming after', lastSeq);
        send({ type: 'resume', lastSeq });
      } else if (frame.type === 'interaction.create') {
        const interaction = frame.interaction as InteractionPayload;
        send({
          type: 'interaction.respond',
          interactionId: interaction.id,
          token: interaction.token,
          response: answer(interaction),
        });
      } else if (frame.type === 'event') {
        const seq = frame.seq as number;
        if (seq > lastSeq) {
          console.log('event', (frame.event as { type: string }).type, 'seq', seq);
          lastSeq = seq;
          if (SEQ_FILE) writeFileSync(SEQ_FILE, String(lastSeq));
        }
        send({ type: 'event.ack', seq });
      } else if (frame.type === 'error') {
        console.error('gateway error', frame.code, frame.message);
      }
    });
    ws.addEventListener('close', () => {
      console.log(`gateway closed; reconnecting in ${String(delayMs)} ms`);
      setTimeout(connect, delayMs);
      delayMs = Math.min(delayMs * 2, 30_000);
    });
    ws.addEventListener('error', () => undefined); // 'close' follows and reconnects
  };
  connect();
}
