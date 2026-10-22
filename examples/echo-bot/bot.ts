import { createServer } from 'node:http';
import { verifySignature } from '@harmony/shared/signature';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const API = process.env.HARMONY_URL ?? 'http://127.0.0.1:8471';
const TOKEN = need('HARMONY_BOT_TOKEN'); // hb_<botId>_<secret>, shown once when the bot is created
const SECRET = need('HARMONY_SIGNING_SECRET'); // hsk_..., shown once as well
const GUILD_ID = need('HARMONY_GUILD_ID');
const PORT = Number(process.env.PORT ?? 4000);
const BOT_ID = TOKEN.split('_')[1];

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

interface Interaction {
  id: string;
  token: string;
  command: { name: string; options: Record<string, string | number | boolean> };
}

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

    const reply = (body: unknown) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));

    if (req.url === '/events') {
      // Deliveries are at-least-once: dedupe on this header if handling is not idempotent.
      const { type } = JSON.parse(raw) as { type: string };
      console.log('event', type, req.headers['x-harmony-delivery-id']);
      return void res.writeHead(204).end();
    }

    const interaction = JSON.parse(raw) as Interaction;
    const { name, options } = interaction.command;
    if (name === 'echo') {
      return reply({ type: 'message', content: String(options.text), ephemeral: true });
    }
    // Deferred: answer within 3 seconds, then post the real message within 15 minutes.
    setTimeout(() => {
      const roll = 1 + Math.floor(Math.random() * Number(options.sides ?? 6));
      const path = `/api/interactions/${interaction.id}/${interaction.token}/followup`;
      harmony(path, 'POST', { content: `You rolled a ${roll}` }, false).catch(console.error);
    }, 1000);
    reply({ type: 'deferred' });
  });
}).listen(PORT, () => console.log(`echo bot listening on :${PORT}`));
