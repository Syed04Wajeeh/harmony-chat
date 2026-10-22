import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

export const echoBotDir = path.resolve('../../examples/echo-bot');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** Runs `examples/echo-bot` and resolves once it has registered its commands and is listening. */
export function startEchoBot(env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['bot.ts'], {
    cwd: echoBotDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`echo bot did not start: ${output}`)), 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`echo bot exited (${String(code)}): ${output}`));
    });
  });
}
