import { hostname } from 'node:os';
import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    HOST: z.string().min(1).default('0.0.0.0'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    WEB_DIST_DIR: z.string().min(1).default('../web/dist'),
    INSTANCE_ID: z.string().min(1).default(hostname()),

    PROXY_SHARED_SECRET: z.string().min(32).optional(),
    PUBLIC_ORIGIN: z
      .url()
      .transform((value) => new URL(value).origin)
      .optional(),
    ALLOWED_LOGINS: csv,
    DEV_AUTH_LOGIN: z
      .string()
      .min(1)
      .transform((value) => value.toLowerCase())
      .optional(),
    DEV_AUTH_NAME: z.string().min(1).optional(),

    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1).default(60_000),
    MESSAGE_RATE_MAX: z.coerce.number().int().min(1).default(20),
    MESSAGE_RATE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(10),
    REACTION_RATE_MAX: z.coerce.number().int().min(1).default(30),
    WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(10).default(30_000),
    WS_FRAME_BURST: z.coerce.number().int().min(1).default(30),
    WS_FRAME_REFILL_PER_SECOND: z.coerce.number().positive().default(3),

    PRESENCE_TTL_MS: z.coerce.number().int().min(100).default(90_000),
    PRESENCE_HEARTBEAT_MS: z.coerce.number().int().min(10).default(30_000),
    PRESENCE_SWEEP_MS: z.coerce.number().int().min(10).default(30_000),

    UPLOAD_DIR: z.string().min(1).default('/data/uploads'),
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .default(10 * 1024 * 1024),
    UPLOAD_RATE_MAX: z.coerce.number().int().min(1).default(20),
    UPLOAD_RATE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    UPLOAD_ORPHAN_TTL_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(24 * 60 * 60 * 1000),
    UPLOAD_CLEANUP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10)
      .default(60 * 60 * 1000),
  })
  .transform((raw, ctx) => {
    const { NODE_ENV, DEV_AUTH_LOGIN, PROXY_SHARED_SECRET, PUBLIC_ORIGIN } = raw;
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    if (DEV_AUTH_LOGIN && NODE_ENV !== 'development') {
      fail('DEV_AUTH_LOGIN', 'only allowed when NODE_ENV=development');
    }
    const devAuth = NODE_ENV === 'development' && DEV_AUTH_LOGIN !== undefined;
    if (!devAuth && !PROXY_SHARED_SECRET) {
      fail('PROXY_SHARED_SECRET', 'required (at least 32 characters)');
    }
    if (NODE_ENV === 'production' && !PUBLIC_ORIGIN) {
      fail('PUBLIC_ORIGIN', 'required in production');
    }
    return { ...raw, PUBLIC_ORIGIN: PUBLIC_ORIGIN ?? 'http://localhost:5173' };
  });

export type Config = z.output<typeof ConfigSchema>;

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.output<T> {
  // Compose passes unset variables through as empty strings; treat them as absent.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value));
  const result = schema.safeParse(present);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return parse(ConfigSchema, env);
}

/** The migrate job only needs the database, not the proxy secret. */
export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return parse(z.object({ DATABASE_URL: z.string().min(1) }), env).DATABASE_URL;
}
