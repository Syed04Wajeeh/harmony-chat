import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  BotGuildParams,
  BotMessage,
  ChannelParams,
  GuildParams,
  InteractionFollowupParams,
  InvokeCommandBody,
  InvokeCommandResponse,
  ListCommandsResponse,
  PutCommandsBody,
  PutCommandsResponse,
} from '@harmony/shared';
import type { CommandRegistry } from './registry.js';
import type { InteractionService } from './interactions.js';

export interface CommandRoutesOptions {
  registry: CommandRegistry;
  interactions: InteractionService;
}

const FollowupResponse = z.object({ messageId: z.string().nullable() });

export const commandRoutes: FastifyPluginCallbackZod<CommandRoutesOptions> = (
  app,
  { registry, interactions },
  done,
) => {
  // The bot itself (scope `commands`) or its human owner.
  app.put(
    '/bots/:id/guilds/:guildId/commands',
    {
      config: { scope: 'commands' },
      schema: {
        params: BotGuildParams,
        body: PutCommandsBody,
        response: { 200: PutCommandsResponse },
      },
    },
    async (request) => ({
      commands: await registry.replace(
        request.user,
        request.bot,
        request.params.id,
        request.params.guildId,
        request.body,
      ),
    }),
  );

  app.get(
    '/guilds/:id/commands',
    {
      config: { scope: 'commands' },
      schema: { params: GuildParams, response: { 200: ListCommandsResponse } },
    },
    async (request) => ({ commands: await registry.list(request.user, request.params.id) }),
  );

  app.post(
    '/channels/:id/commands',
    {
      config: { humanOnly: true },
      schema: {
        params: ChannelParams,
        body: InvokeCommandBody,
        response: { 202: InvokeCommandResponse },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(await interactions.invoke(request.user, request.params.id, request.body)),
  );

  // The interaction token in the path is the credential, like a webhook URL.
  app.post(
    '/interactions/:id/:token/followup',
    {
      config: { public: true, rateLimit: false },
      schema: {
        params: InteractionFollowupParams,
        body: BotMessage,
        response: { 201: FollowupResponse },
      },
    },
    async (request, reply) => {
      const message = await interactions.followup(
        request.params.id,
        request.params.token,
        request.body,
      );
      return reply.code(201).send({ messageId: message?.id ?? null });
    },
  );
  done();
};
