#!/usr/bin/env node
import { agentdEnabled } from './agentd-config.js';

// A Claude Code hook: the event arrives as JSON on stdin and the decision (if any) leaves as JSON
// on stdout. Exit code 0 always, so a broken hook never blocks Claude Code; diagnostics go to
// stderr, which Claude Code only shows in its debug log, and never contain the token.
const STDIN_LIMIT = 1024 * 1024;
const STDIN_WAIT_MS = 5000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const reading = (async () => {
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > STDIN_LIMIT) break;
      chunks.push(chunk);
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    reading,
    new Promise((resolve) => {
      timer = setTimeout(resolve, STDIN_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const input = await readStdin();
  let done = false;
  // With HARMONY_AGENTD=1 the event goes to the local daemon first. That path loads only node
  // built-ins, so a tool call that needs no decision costs one short process.
  if (agentdEnabled(process.env)) {
    const { viaDaemon } = await import('./agentd-client.js');
    const via = await viaDaemon(input, process.env);
    if (via.log) console.error(via.log);
    if (via.stdout) process.stdout.write(`${via.stdout}\n`);
    done = via.handled;
  }
  if (!done) {
    const { runHook } = await import('./hook.js');
    const result = await runHook(input, process.env);
    if (result.log) console.error(result.log);
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  }
} catch (error) {
  console.error('harmony-hook: unexpected error:', error instanceof Error ? error.message : error);
}
// Open sockets and timers must not keep the hook alive once it has answered.
process.exitCode = 0;
setImmediate(() => process.exit(0));
