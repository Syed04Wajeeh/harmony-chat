import { writeFileSync } from 'node:fs';
import { pino } from 'pino';
import { loadWorkerConfig } from './config.js';
import { createDb } from './db.js';
import { EventWorker } from './events/worker.js';
import { modules } from './modules/index.js';
import { activeModules } from './modules/registry.js';
import { startWorkerModules } from './modules/worker-host.js';

const config = loadWorkerConfig();
const log = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
});
const db = createDb(config.DATABASE_URL);

// The compose healthcheck checks this file's age, so a stuck loop turns the container unhealthy.
const heartbeat = () => {
  try {
    writeFileSync(config.HEARTBEAT_FILE, String(Date.now()));
  } catch (err) {
    log.warn({ err }, 'could not write heartbeat');
  }
};

const moduleJobs = await startWorkerModules(activeModules(modules, config.MODULES_DISABLED), {
  db,
  env: process.env,
  log,
});
const worker = new EventWorker(db, config, log, Math.random, heartbeat);
const beat = setInterval(heartbeat, 10_000);
beat.unref();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'worker shutting down; finishing in-flight deliveries');
  clearInterval(beat);
  try {
    await worker.stop();
    await moduleJobs.stop();
    await db.destroy();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

heartbeat();
await worker.start();
log.info({ instanceId: config.INSTANCE_ID }, 'worker started');
