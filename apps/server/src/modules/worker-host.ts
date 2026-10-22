import type { Kysely } from 'kysely';
import { parseEnv } from '../config.js';
import type { Database } from '../db/schema.js';
import type { HarmonyModule } from './types.js';

export interface WorkerHostLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Loads the module list in the worker process. Modules there get no routes or sockets, only a
 * database handle, their config and periodic jobs.
 */
export async function startWorkerModules(
  modules: readonly HarmonyModule[],
  deps: { db: Kysely<Database>; env: NodeJS.ProcessEnv; log: WorkerHostLogger },
): Promise<{ stop(): Promise<void> }> {
  const timers = new Set<NodeJS.Timeout>();
  const running = new Set<Promise<void>>();
  let stopped = false;

  for (const module of modules) {
    if (!module.registerWorker) continue;
    const config = module.config ? parseEnv(module.config, deps.env) : {};
    await module.registerWorker({
      id: module.id,
      log: deps.log,
      db: deps.db,
      config,
      every: (name, intervalMs, job) => {
        const tick = () => {
          const run = job()
            .catch((err: unknown) => {
              deps.log.warn({ err, module: module.id, job: name }, 'module job failed');
            })
            .finally(() => {
              running.delete(run);
              if (!stopped) schedule();
            });
          running.add(run);
        };
        const schedule = () => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            tick();
          }, intervalMs);
          timer.unref();
          timers.add(timer);
        };
        schedule();
      },
    });
  }

  return {
    async stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      await Promise.allSettled([...running]);
    },
  };
}
