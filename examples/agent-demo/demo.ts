// A scripted "agent": it uses Harmony through the MCP server exactly as Claude would, with the
// MCP SDK client over stdio. It starts a run, works through some steps, asks for approval before
// a "deploy", waits for a person to press a button, and finishes. Nothing here is Harmony-specific
// beyond the tool names, which is the point: any MCP client can do this.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    console.error(`Set ${name}. See README.md.`);
    process.exit(2);
  }
  return value;
};

const entry = env(
  'HARMONY_MCP_ENTRY',
  path.resolve(import.meta.dirname, '../../packages/mcp/dist/index.js'),
);
const dashboard = env('DEMO_DASHBOARD_CHANNEL');
const approvals = env('DEMO_APPROVAL_CHANNEL');
const pace = Number(process.env['DEMO_PACE_MS'] ?? '2500');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const client = new Client({ name: 'agent-demo', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      PATH: process.env['PATH'] ?? '',
      HARMONY_URL: env('HARMONY_URL'),
      HARMONY_BOT_TOKEN: env('HARMONY_BOT_TOKEN'),
    },
    stderr: 'inherit',
  }),
);

interface Outcome {
  isError: boolean;
  text: string;
  data: Record<string, unknown> | undefined;
}

async function call(tool: string, args: Record<string, unknown>): Promise<Outcome> {
  const result = (await client.callTool({ name: tool, arguments: args }, undefined, {
    timeout: 3_700_000,
  })) as {
    isError?: boolean;
    content: { text?: string }[];
    structuredContent?: Record<string, unknown>;
  };
  const text = result.content.map((part) => part.text ?? '').join('\n');
  console.log(`${tool}: ${text.split('\n')[0] ?? ''}`);
  return { isError: result.isError === true, text, data: result.structuredContent };
}

/** Every tool answers with a stop notice once a person cancels the run. */
const cancelled = (outcome: Outcome) => outcome.isError && outcome.text.includes('cancelled');

await call('start_run', {
  title: 'Release 2.4',
  channel: dashboard,
  step: 'Running the test suite',
  totalSteps: 4,
});
await sleep(pace);
if (
  cancelled(await call('update_run', { step: 'Building the image', note: 'tests passed (412)' }))
) {
  process.exit(0);
}
await sleep(pace);

// The side effect: nothing happens until a person with the permission presses Approve.
const decision = await call('request_approval', {
  channel: approvals,
  title: 'Deploy release 2.4 to production',
  details:
    'Rolls build `2.4.0` out to **production** (3 hosts, rolling).\n\nRollback: `deploy rollback 2.3.2`.',
  risk: 'high',
  timeoutSeconds: Number(process.env['DEMO_APPROVAL_SECONDS'] ?? '600'),
});
if (cancelled(decision)) process.exit(0);

if (decision.data?.['decision'] === 'approved') {
  if (
    cancelled(await call('update_run', { step: 'Deploying to production', note: 'deploy started' }))
  ) {
    process.exit(0);
  }
  await sleep(pace);
  await call('finish_run', { status: 'done', summary: 'Release 2.4 is live on all hosts' });
} else {
  await call('finish_run', {
    status: 'failed',
    summary: `Deploy not approved (${String(decision.data?.['decision'])})`,
  });
}
await client.close();
