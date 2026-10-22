import type { ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { DevApi } from './dev-api.js';
import { freePort, startEchoBot } from './echo-bot.js';

export interface IntegrationsSeed {
  guildId: string;
  channels: { general: string; alerts: string; jobs: string };
  botId: string;
  /** A fake token for the screenshot of the one-time webhook URL. */
  fakeWebhookPath: string;
  stop(): Promise<void>;
}

const minutesAgo = (minutes: number) => {
  const time = new Date(Date.now() - minutes * 60_000).toISOString();
  // Uptime Kuma sends `YYYY-MM-DD HH:mm:ss.SSS` in UTC.
  return time.replace('T', ' ').replace('Z', '');
};

/** Fictional "Home Lab" server with alert and job-scan webhooks, and an echo bot with a delivery log. */
export async function seedIntegrations(
  baseUrl: string,
  ada: DevApi,
  others: DevApi[],
): Promise<IntegrationsSeed> {
  const guild = await ada.createGuild('Home Lab');
  const invite = await ada.createInvite(guild.id);
  for (const person of others) await person.acceptInvite(invite.code);
  const general = (await ada.channels()).find(
    (c) => c.guildId === guild.id && c.name === 'general',
  );
  if (!general) throw new Error('general channel missing');
  const alerts = await ada.createChannel(guild.id, 'alerts', {
    topic: 'Uptime Kuma notifications',
  });
  const jobs = await ada.createChannel(guild.id, 'job-scans', { topic: 'Daily scan results' });

  const kuma = await ada.createWebhook(alerts.id, 'Uptime Kuma');
  const kumaEmbed = (down: boolean, minutes: number) => ({
    username: 'Uptime Kuma',
    embeds: [
      {
        title: down ? '❌ Nextcloud is down' : '✅ Nextcloud is back up',
        color: down ? 15158332 : 3066993,
        timestamp: minutesAgo(minutes),
        fields: [
          { name: 'Service Name', value: 'Nextcloud', inline: true },
          { name: 'Service URL', value: 'https://cloud.example.com', inline: true },
          { name: 'Time (UTC)', value: minutesAgo(minutes).slice(0, 19), inline: true },
          ...(down
            ? [{ name: 'Error', value: 'timeout of 48000ms exceeded' }]
            : [{ name: 'Uptime (24h)', value: '99.2%' }]),
        ],
      },
    ],
  });
  await ada.execute(kuma.url, kumaEmbed(true, 14));
  await ada.execute(kuma.url, kumaEmbed(false, 3));

  const scan = await ada.createWebhook(jobs.id, 'Job Scan');
  await ada.execute(scan.url, {
    username: 'Job Scan',
    content: "3 new matches from this morning's scan",
    embeds: [
      {
        author: { name: 'Example Corp · Remote (EU)' },
        title: 'Senior Platform Engineer',
        url: 'https://jobs.example.com/platform-engineer',
        description:
          'Own the **deployment platform** for ~40 services. Kubernetes, Terraform and a calm on-call.\n> Strong match on infrastructure and TypeScript.',
        color: 5793266,
        thumbnail: { url: `${baseUrl}/icon-192.png` },
        fields: [
          { name: 'Match', value: '92%', inline: true },
          { name: 'Salary', value: '€85k–€105k', inline: true },
          { name: 'Posted', value: '2 days ago', inline: true },
          { name: 'Stack', value: 'Kubernetes, Terraform, TypeScript, Postgres' },
        ],
        footer: { text: 'Source: example.com/jobs' },
        timestamp: new Date(Date.now() - 40 * 60_000).toISOString(),
      },
      {
        author: { name: 'Sample Labs · Berlin' },
        title: 'Backend Engineer, Data Platform',
        url: 'https://jobs.example.com/backend-engineer',
        description: 'Build ingestion pipelines on Postgres and Redis.',
        color: 5793266,
        fields: [
          { name: 'Match', value: '81%', inline: true },
          { name: 'Salary', value: 'Not listed', inline: true },
          { name: 'Posted', value: 'today', inline: true },
        ],
        footer: { text: 'Source: example.com/jobs' },
      },
    ],
  });

  // The bot's events go to a stub that fails reaction events, so the delivery log has both outcomes.
  const eventsPort = await freePort();
  const stub: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const failing = body.includes('"type":"reaction.added"');
      response.writeHead(failing ? 503 : 204).end();
    });
  });
  await new Promise<void>((resolve) => stub.listen(eventsPort, '127.0.0.1', resolve));

  const botPort = await freePort();
  const created = await ada.createBot({
    name: 'Echo',
    scopes: ['messages.read', 'messages.write', 'commands', 'events'],
    interactionsUrl: `http://127.0.0.1:${String(botPort)}/interactions`,
    eventsUrl: `http://127.0.0.1:${String(eventsPort)}/events`,
    eventTypes: ['message.created', 'reaction.added'],
  });
  await ada.addBotToGuild(guild.id, created.bot.id);
  const bot: ChildProcess = await startEchoBot({
    HARMONY_URL: baseUrl,
    HARMONY_BOT_TOKEN: created.token,
    HARMONY_SIGNING_SECRET: created.signingSecret,
    HARMONY_GUILD_ID: guild.id,
    PORT: String(botPort),
  });

  return {
    guildId: guild.id,
    channels: { general: general.id, alerts: alerts.id, jobs: jobs.id },
    botId: created.bot.id,
    fakeWebhookPath: '/api/webhooks/1042/Kq3v-EXAMPLE-not-a-real-token-xyz0123456789',
    async stop() {
      bot.kill();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    },
  };
}

/** Chatter in a channel the bot is in, so it has events to receive. Reactions fail on purpose. */
export async function generateEvents(ada: DevApi, channelId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const message = await ada.send(channelId, `Event traffic ${String(i + 1)}`);
    if (i % 2 === 1) await ada.react(message.id, '👍');
  }
}
