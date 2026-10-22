import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/schema.js';
import { startWorkerModules } from '../../src/modules/worker-host.js';
import { defineModule } from '../../src/modules/types.js';

const log = { info: vi.fn(), warn: vi.fn() };
const db = {} as Kysely<Database>;

describe('startWorkerModules', () => {
  it('gives the module its config and runs its jobs repeatedly until stopped', async () => {
    const seen: string[] = [];
    const job = vi.fn(() => Promise.resolve());
    const module = defineModule({
      id: 'jobs',
      name: 'Jobs',
      description: 'x',
      optional: true,
      register: () => undefined,
      registerWorker: (ctx) => {
        seen.push(ctx.id);
        ctx.every('tick', 10, job);
      },
    });
    const host = await startWorkerModules([module], { db, env: {}, log });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await host.stop();
    const calls = job.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(seen).toEqual(['jobs']);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(job.mock.calls.length).toBe(calls);
  });

  it('logs a failing job and keeps scheduling it', async () => {
    const warn = vi.fn();
    let attempts = 0;
    const module = defineModule({
      id: 'flaky',
      name: 'Flaky',
      description: 'x',
      optional: true,
      register: () => undefined,
      registerWorker: (ctx) =>
        ctx.every('flaky', 5, () => {
          attempts++;
          return Promise.reject(new Error('nope'));
        }),
    });
    const host = await startWorkerModules([module], { db, env: {}, log: { info: vi.fn(), warn } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.stop();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalled();
  });

  it('skips modules without worker hooks', async () => {
    const module = defineModule({
      id: 'plain',
      name: 'Plain',
      description: 'x',
      optional: true,
      register: () => undefined,
    });
    await expect(startWorkerModules([module], { db, env: {}, log })).resolves.toBeDefined();
  });
});
