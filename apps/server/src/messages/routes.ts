import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  ChannelParams,
  ListMessagesQuery,
  ListMessagesResponse,
  Message,
  SendMessageBody,
} from '@harmony/shared';
import type { ChannelService } from '../channels/service.js';
import { AppError } from '../errors.js';
import type { MessageService } from './service.js';

export interface MessageRoutesOptions {
  channels: ChannelService;
  messages: MessageService;
}

export const messageRoutes: FastifyPluginCallbackZod<MessageRoutesOptions> = (
  app,
  { channels, messages },
  done,
) => {
  app.get(
    '/channels/:id/messages',
    {
      schema: {
        params: ChannelParams,
        querystring: ListMessagesQuery,
        response: { 200: ListMessagesResponse },
      },
    },
    async (request) => {
      const { id } = request.params;
      if (!(await channels.exists(id))) {
        throw new AppError(404, 'channel_not_found', 'Channel not found');
      }
      const { before, limit } = request.query;
      return messages.history(id, limit, before);
    },
  );

  app.post(
    '/channels/:id/messages',
    {
      schema: { params: ChannelParams, body: SendMessageBody, response: { 201: Message } },
    },
    async (request, reply) => {
      const { content, nonce } = request.body;
      const message = await messages.send({
        author: request.user,
        channelId: request.params.id,
        content,
        nonce,
      });
      return reply.code(201).send(message);
    },
  );
  done();
};
