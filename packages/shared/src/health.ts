import { z } from 'zod';

export const HealthResponse = z.object({
  /** Lets clients such as the desktop app confirm they reached Harmony. Sent by `/healthz`. */
  service: z.literal('harmony').optional(),
  status: z.enum(['ok', 'degraded']),
  checks: z.record(z.string(), z.enum(['up', 'down'])).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
