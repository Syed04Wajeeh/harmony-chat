import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  ChannelParams,
  CreateWebhookBody,
  CreatedWebhook,
  ListWebhooksResponse,
  Message,
  WebhookExecuteBody,
  WebhookExecuteParams,
  WebhookExecuteQuery,
  WebhookParams,
} from '@harmony/shared';
import type { WebhookService } from './service.js';

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

  app.delete(
    '/webhooks/:id',
    { config: { humanOnly: true }, schema: { params: WebhookParams } },
    async (request, reply) => {
      await webhooks.delete(request.user, request.params.id);
      return reply.code(204).send();
    },
  );

  // No other authentication: the token in the path is the credential, so this skips the proxy
  // identity, the Origin check and the per-user HTTP limiter (it has its own per-webhook limit).
  app.post(
    '/webhooks/:id/:token',
    {
      config: { public: true, rateLimit: false },
      schema: {
        params: WebhookExecuteParams,
        querystring: WebhookExecuteQuery,
        body: WebhookExecuteBody,
        response: { 200: Message, 204: z.void() },
      },
    },
    async (request, reply) => {
      const message = await webhooks.execute(request.params.id, request.params.token, request.body);
      if (request.query.wait === 'true') return reply.code(200).send(message);
      return reply.code(204).send();
    },
  );
  done();
};
