import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  ChannelParams,
  CreateWebhookBody,
  CreatedWebhook,
  ListWebhooksResponse,
  Message,
  PreviewWebhookBody,
  PreviewWebhookResponse,
  UpdateWebhookBody,
  Webhook,
  WebhookExecuteParams,
  WebhookExecuteQuery,
  WebhookParams,
} from '@harmony/shared';
import { AppError } from '../errors.js';
import type { WebhookService } from './service.js';

/** What the body parsers below hand the handler: the bytes a signature covers, and the data. */
interface ParsedBody {
  raw: Buffer;
  body: unknown;
}

export const webhookRoutes: FastifyPluginCallbackZod<{ webhooks: WebhookService }> = (
  app,
  { webhooks },
  done,
) => {
  app.post(
    '/channels/:id/webhooks',
    {
      config: { humanOnly: true },
      schema: { params: ChannelParams, body: CreateWebhookBody, response: { 201: CreatedWebhook } },
    },
    async (request, reply) =>
      reply.code(201).send(await webhooks.create(request.user, request.params.id, request.body)),
  );

  app.get(
    '/channels/:id/webhooks',
    {
      config: { humanOnly: true },
      schema: { params: ChannelParams, response: { 200: ListWebhooksResponse } },
    },
    async (request) => ({ webhooks: await webhooks.list(request.user, request.params.id) }),
  );

  app.patch(
    '/webhooks/:id',
    {
      config: { humanOnly: true },
      schema: { params: WebhookParams, body: UpdateWebhookBody, response: { 200: Webhook } },
    },
    async (request) => webhooks.update(request.user, request.params.id, request.body),
  );

  // Renders a sample without posting, for the webhook editor. The static `preview` segment wins
  // over the `:token` route below, and the call needs a signed-in manager, which the integration
  // ingress never has.
  app.post(
    '/webhooks/:id/preview',
    {
      config: { humanOnly: true },
      schema: {
        params: WebhookParams,
        body: PreviewWebhookBody,
        response: { 200: PreviewWebhookResponse },
      },
    },
    async (request) => webhooks.preview(request.user, request.params.id, request.body),
  );

  app.delete(
    '/webhooks/:id',
    { config: { humanOnly: true }, schema: { params: WebhookParams } },
    async (request, reply) => {
      await webhooks.delete(request.user, request.params.id);
      return reply.code(204).send();
    },
  );

  // Its own context, so the body parsers that keep the raw bytes (a signature covers them) and
  // accept text and form bodies apply here and nowhere else.
  app.register(executeRoute, { webhooks });
  done();
};

const executeRoute: FastifyPluginCallbackZod<{ webhooks: WebhookService }> = (
  inner,
  { webhooks },
  innerDone,
) => {
  const parsed = (raw: Buffer, body: unknown): ParsedBody => ({ raw, body });

  inner.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, raw, next) => {
    const bytes = raw as Buffer;
    if (bytes.length === 0) return next(null, parsed(bytes, undefined));
    try {
      next(null, parsed(bytes, JSON.parse(bytes.toString('utf8'))));
    } catch {
      next(new AppError(400, 'invalid_json', 'The body is not valid JSON'));
    }
  });
  inner.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_request, raw, next) => {
    next(null, parsed(raw as Buffer, (raw as Buffer).toString('utf8')));
  });
  // GitHub's form-encoded delivery wraps the JSON in a `payload` field.
  inner.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'buffer' },
    (_request, raw, next) => {
      const bytes = raw as Buffer;
      const form = new URLSearchParams(bytes.toString('utf8'));
      const payload = form.get('payload');
      if (payload === null) return next(null, parsed(bytes, Object.fromEntries(form)));
      try {
        next(null, parsed(bytes, JSON.parse(payload)));
      } catch {
        next(new AppError(400, 'invalid_json', 'The payload field is not valid JSON'));
      }
    },
  );

  // No other authentication: the token in the path is the credential, so this skips the proxy
  // identity, the Origin check and the per-user HTTP limiter (it has its own per-webhook limit).
  inner.post(
    '/webhooks/:id/:token',
    {
      config: { public: true, rateLimit: false },
      schema: {
        params: WebhookExecuteParams,
        querystring: WebhookExecuteQuery,
        response: { 200: Message, 204: z.void() },
      },
    },
    async (request, reply) => {
      const incoming = (request.body ?? { raw: Buffer.alloc(0), body: undefined }) as ParsedBody;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      const message = await webhooks.execute(request.params.id, request.params.token, {
        raw: incoming.raw,
        body: incoming.body,
        headers,
      });
      if (message && request.query.wait === 'true') return reply.code(200).send(message);
      return reply.code(204).send();
    },
  );
  innerDone();
};
