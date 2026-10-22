import multipart from '@fastify/multipart';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AttachmentParams, UploadResponse } from '@harmony/shared';
import { AppError } from '../../errors.js';
import type { RateLimiter } from '../../rate-limit.js';
import type { UploadService } from './service.js';

export interface UploadRoutesOptions {
  uploads: UploadService;
  limiter: RateLimiter;
  maxBytes: number;
}

/** Only raster formats browsers cannot be tricked into executing are shown inline. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const uploadRoutes: FastifyPluginAsyncZod<UploadRoutesOptions> = async (
  app,
  { uploads, limiter, maxBytes },
) => {
  await app.register(multipart, { limits: { fileSize: maxBytes, files: 1, fields: 5 } });
  app.post(
    '/uploads',
    { config: { humanOnly: true }, schema: { response: { 201: UploadResponse } } },
    async (request, reply) => {
      if (!(await limiter.consume(request.user.id))) {
        throw new AppError(429, 'rate_limited', 'You are uploading too quickly');
      }
      if (!request.isMultipart()) {
        throw new AppError(400, 'invalid_request', 'Expected multipart/form-data');
      }
      const file = await request.file();
      if (!file) throw new AppError(400, 'no_file', 'No file was uploaded');
      const attachment = await uploads.store(request.user, file.filename, file.file);
      return reply.code(201).send(attachment);
    },
  );

  app.get(
    '/attachments/:id/:filename',
    { config: { scope: 'messages.read' }, schema: { params: AttachmentParams } },
    async (request, reply) => {
      const { row, stream } = await uploads.open(request.user, request.params.id);
      const disposition = INLINE_TYPES.has(row.content_type) ? 'inline' : 'attachment';
      const ascii = row.filename.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '_');
      return reply
        .header('Content-Type', row.content_type)
        .header('Content-Length', row.size_bytes)
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        )
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .send(stream);
    },
  );
};
