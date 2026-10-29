// Drives the built stdio server like an MCP client would, for the server's integration test.
// Usage: node stdio-driver.mjs <channelId>; HARMONY_URL and HARMONY_BOT_TOKEN come from the environment.
// Prints one JSON line per tool call: {tool, isError, text, data}.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const [channel] = process.argv.slice(2);

const client = new Client({ name: 'integration-driver', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      PATH: process.env.PATH ?? '',
      HARMONY_URL: process.env.HARMONY_URL ?? '',
      HARMONY_BOT_TOKEN: process.env.HARMONY_BOT_TOKEN ?? '',
    },
    stderr: 'ignore',
  }),
);

async function call(tool, args) {
  const result = await client.callTool({ name: tool, arguments: args }, undefined, {
    timeout: 60_000,
  });
  const text = result.content.map((part) => part.text ?? '').join('\n');
  console.log(
    JSON.stringify({
      tool,
      isError: result.isError === true,
      text,
      data: result.structuredContent,
    }),
  );
}

await call('list_channels', {});
await call('ask_human', { channel, question: 'Ready to ship?', timeoutSeconds: 30 });
await client.close();
