import multipart from '@fastify/multipart';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AttachmentParams, EmojiImageParams, Id, UploadResponse, type Perk } from '@harmony/shared';
import type { DirectoryUser } from '@harmony/shared';
import { AppError } from '../../errors.js';
import type { RateLimiter } from '../../rate-limit.js';
import type { UploadService } from './service.js';

export interface UploadRoutesOptions {
  uploads: UploadService;
  /** Checks `attach_files` in the channel an upload is meant for. */
  canAttach: (user: DirectoryUser, channelId: string) => Promise<void>;
  limiter: RateLimiter;
  maxBytes: number;
  /** The limit for users with the `larger_uploads` perk. */
  maxBytesPerk: number;
  hasPerk: (user: DirectoryUser, perk: Perk) => Promise<boolean>;
}

/** Only raster formats browsers cannot be tricked into executing are shown inline. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const uploadRoutes: FastifyPluginAsyncZod<UploadRoutesOptions> = async (
  app,
  { uploads, canAttach, limiter, maxBytes, maxBytesPerk, hasPerk },
) => {
  await app.register(multipart, {
    limits: { fileSize: Math.max(maxBytes, maxBytesPerk), files: 1, fields: 5 },
  });
  app.post(
    '/uploads',
    {
      config: { humanOnly: true },
      schema: {
        querystring: z.object({ channelId: Id.optional() }),
        response: { 201: UploadResponse },
      },
    },
    async (request, reply) => {
      if (request.query.channelId) await canAttach(request.user, request.query.channelId);
      if (!(await limiter.consume(request.user.id))) {
        throw new AppError(429, 'rate_limited', 'You are uploading too quickly');
      }
      if (!request.isMultipart()) {
        throw new AppError(400, 'invalid_request', 'Expected multipart/form-data');
      }
      const file = await request.file();
      if (!file) throw new AppError(400, 'no_file', 'No file was uploaded');
      const limit = (await hasPerk(request.user, 'larger_uploads')) ? maxBytesPerk : maxBytes;
      const attachment = await uploads.store(request.user, file.filename, file.file, limit);
      return reply.code(201).send(attachment);
    },
  );

  const sendFile = async (
    reply: FastifyReply,
    { row, stream }: Awaited<ReturnType<UploadService['open']>>,
  ) => {
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
  };

  app.get(
    '/attachments/:id/:filename',
    { config: { scope: 'messages.read' }, schema: { params: AttachmentParams } },
    async (request, reply) => sendFile(reply, await uploads.open(request.user, request.params.id)),
  );

  /** Custom emoji images are public to signed-in users: messages in any server may show them. */
  app.get(
    '/emoji/:emojiId/:filename',
    { config: { scope: 'messages.read' }, schema: { params: EmojiImageParams } },
    async (request, reply) =>
      sendFile(reply, await uploads.openEmoji(request.user, request.params.emojiId)),
  );
};
