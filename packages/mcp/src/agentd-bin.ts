#!/usr/bin/env node
import { statSync } from 'node:fs';
import { daemonPaths, requireToken } from './agentd-config.js';
import { AlreadyRunning, loadAgentdConfig, startAgentd, stopDaemon } from './agentd.js';
import { callDaemon } from './agentd-client.js';

// The local daemon behind `harmony-hook` (see docs/agents.md, "Agent control room"). The hook
// starts it on demand, so it is normally never run by hand. `harmony-agentd status` and
// `harmony-agentd stop` talk to a running one; with no argument it runs in the foreground.
const command = process.argv[2];

try {
  if (command === 'status' || command === 'stop') {
    const paths = daemonPaths(process.env, requireToken(process.env));
    if (command === 'stop') {
      console.log((await stopDaemon(paths.socket)) ? 'stopped' : 'not running');
    } else {
      const { reply } = await callDaemon(paths.socket, { v: 1, op: 'status' });
      console.log(reply?.ok ? JSON.stringify(reply.status, null, 2) : 'not running');
    }
    process.exit(0);
  }
  const config = loadAgentdConfig(process.env);
  const daemon = await startAgentd(config);
  const stop = () => void daemon.close();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // The log file grows only with warnings, but a runaway should not fill a disk.
  try {
    if (statSync(config.paths.log).size > 5_000_000) console.error('harmony-agentd: log is large');
  } catch {
    // no log file when run in the foreground
  }
  await daemon.closed;
  process.exit(0);
} catch (error) {
  if (error instanceof AlreadyRunning) process.exit(0);
  console.error('harmony-agentd:', error instanceof Error ? error.message : 'failed');
  process.exit(1);
}
