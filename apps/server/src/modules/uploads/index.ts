import { z } from 'zod';
import { defineModule } from '../types.js';
import { UploadCleaner } from './cleaner.js';
import { uploadRoutes } from './routes.js';
import { UploadService } from './service.js';

const Config = z.object({
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
});

/**
 * File uploads and downloads, and the sweep that removes uploads never attached to a message.
 * Attachments themselves (the table, the `attachments` field of a message, guild icons) are
 * core; storage is shared infrastructure, so this module is not optional.
 */
export const uploads = defineModule({
  id: 'uploads',
  name: 'Uploads',
  description: 'Attach files and images to messages.',
  optional: false,
  config: Config,

  register(ctx) {
    const { config } = ctx;
    const service = new UploadService(ctx.db, ctx.storage);
    const limiter = ctx.limiter(
      'upload',
      config.UPLOAD_RATE_MAX,
      config.UPLOAD_RATE_WINDOW_SECONDS,
    );
    ctx.routes(async (app) => {
      await app.register(uploadRoutes, {
        uploads: service,
        limiter,
        maxBytes: config.UPLOAD_MAX_BYTES,
      });
    });

    const cleaner = new UploadCleaner(
      ctx.db,
      ctx.redis,
      ctx.storage,
      {
        orphanTtlMs: config.UPLOAD_ORPHAN_TTL_MS,
        intervalMs: config.UPLOAD_CLEANUP_INTERVAL_MS,
        instanceId: ctx.instanceId,
      },
      ctx.log,
    );
    ctx.onReady(() => cleaner.start());
    ctx.onClose(() => cleaner.stop());
  },
});
