import { z } from 'zod';

export const version = '0.0.0';

export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.record(z.string(), z.enum(['up', 'down'])).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
