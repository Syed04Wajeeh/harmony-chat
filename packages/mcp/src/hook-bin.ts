#!/usr/bin/env node
import { runHook } from './hook.js';

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
  const result = await runHook(await readStdin(), process.env);
  if (result.log) console.error(result.log);
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
} catch (error) {
  console.error('harmony-hook: unexpected error:', error instanceof Error ? error.message : error);
}
// Open sockets and timers must not keep the hook alive once it has answered.
process.exitCode = 0;
setImmediate(() => process.exit(0));
