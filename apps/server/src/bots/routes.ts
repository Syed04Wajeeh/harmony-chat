import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  AddGuildBotBody,
  Bot,
  BotParams,
  CreateBotBody,
  CreatedBot,
  DeliveryParams,
  GuildBotParams,
  GuildParams,
  ListBotsResponse,
  ListDeliveriesQuery,
  ListDeliveriesResponse,
  RotatedSigningSecret,
  RotatedToken,
  UpdateBotBody,
} from '@harmony/shared';
import type { BotService } from './service.js';

const humanOnly = { humanOnly: true } as const;

/** Bot management and the delivery log. Bots never manage bots, so every route is human-only. */
export const botRoutes: FastifyPluginCallbackZod<{ bots: BotService }> = (app, { bots }, done) => {
  app.post(
    '/bots',
    { config: humanOnly, schema: { body: CreateBotBody, response: { 201: CreatedBot } } },
    async (request, reply) => reply.code(201).send(await bots.create(request.user, request.body)),
  );

  app.get(
    '/bots',
    { config: humanOnly, schema: { response: { 200: ListBotsResponse } } },
    async (request) => ({ bots: await bots.list(request.user) }),
  );

  app.get(
    '/bots/:id',
    { config: humanOnly, schema: { params: BotParams, response: { 200: Bot } } },
    (request) => bots.get(request.user, request.params.id),
  );

  app.patch(
    '/bots/:id',
    {
      config: humanOnly,
      schema: { params: BotParams, body: UpdateBotBody, response: { 200: Bot } },
    },
    (request) => bots.update(request.user, request.params.id, request.body),
  );

  app.delete(
    '/bots/:id',
    { config: humanOnly, schema: { params: BotParams } },
    async (request, reply) => {
      await bots.delete(request.user, request.params.id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/bots/:id/token',
    { config: humanOnly, schema: { params: BotParams, response: { 200: RotatedToken } } },
    async (request) => ({ token: await bots.rotateToken(request.user, request.params.id) }),
  );

  app.post(
    '/bots/:id/signing-secret',
    { config: humanOnly, schema: { params: BotParams, response: { 200: RotatedSigningSecret } } },
    async (request) => ({
      signingSecret: await bots.rotateSigningSecret(request.user, request.params.id),
    }),
  );

  app.get(
    '/bots/:id/deliveries',
    {
      config: humanOnly,
      schema: {
        params: BotParams,
        querystring: ListDeliveriesQuery,
        response: { 200: ListDeliveriesResponse },
      },
    },
    async (request) => ({
      deliveries: await bots.deliveries(request.user, request.params.id, request.query),
    }),
  );

  app.post(
    '/bots/:id/deliveries/:deliveryId/redeliver',
    { config: humanOnly, schema: { params: DeliveryParams } },
    async (request, reply) => {
      await bots.redeliver(request.user, request.params.id, request.params.deliveryId);
      return reply.code(202).send();
    },
  );

  app.post(
    '/guilds/:id/bots',
    { config: humanOnly, schema: { params: GuildParams, body: AddGuildBotBody } },
    async (request, reply) => {
      await bots.addToGuild(request.user, request.params.id, request.body.botId);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/guilds/:id/bots/:botId',
    { config: humanOnly, schema: { params: GuildBotParams } },
    async (request, reply) => {
      await bots.removeFromGuild(request.user, request.params.id, request.params.botId);
      return reply.code(204).send();
    },
  );
  done();
};
