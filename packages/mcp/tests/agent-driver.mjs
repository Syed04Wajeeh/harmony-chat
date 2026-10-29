// Drives the built stdio server like an agent would, for the server's integration test of the
// agent hub: a run, two approvals, then work that a person cancels.
// Usage: node agent-driver.mjs <dashboardChannelId> <textChannelId>
// HARMONY_URL and HARMONY_BOT_TOKEN come from the environment. Prints one JSON line per result:
// {tool, isError, text, data}.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const [dashboard, text] = process.argv.slice(2);

const client = new Client({ name: 'agent-driver', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      PATH: process.env.PATH ?? '',
      HARMONY_URL: process.env.HARMONY_URL ?? '',
      HARMONY_BOT_TOKEN: process.env.HARMONY_BOT_TOKEN ?? '',
      HARMONY_PANEL_MIN_INTERVAL_MS: '50',
    },
    stderr: 'ignore',
  }),
);

async function call(tool, args, quiet = false) {
  const result = await client.callTool({ name: tool, arguments: args }, undefined, {
    timeout: 60_000,
  });
  const out = {
    tool,
    isError: result.isError === true,
    text: result.content.map((part) => part.text ?? '').join('\n'),
    data: result.structuredContent,
  };
  if (!quiet || out.isError) console.log(JSON.stringify(out));
  return out;
}

await call('start_run', { title: 'Ship the release', channel: dashboard, step: 'Preparing' });
await call('request_approval', {
  channel: text,
  title: 'Deploy to production',
  details: 'Rolls out build 42.',
  risk: 'high',
  timeoutSeconds: 30,
});
await call('request_approval', { channel: text, title: 'Delete old backups', timeoutSeconds: 30 });
await call('update_run', { step: 'Working' });

// Keep working until a person cancels the run.
const deadline = Date.now() + 30_000;
for (;;) {
  const out = await call('update_run', { step: `tick ${Date.now()}` }, true);
  if (out.isError || Date.now() > deadline) break;
  await new Promise((resolve) => setTimeout(resolve, 150));
}
await client.close();
