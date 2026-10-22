import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  ChannelParams,
  EditMessageBody,
  ListMessagesQuery,
  ListMessagesResponse,
  Message,
  MessageParams,
  SendMessageBody,
} from '@harmony/shared';
import type { ChannelService } from '../channels/service.js';
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
      config: { scope: 'messages.read' },
      schema: {
        params: ChannelParams,
        querystring: ListMessagesQuery,
        response: { 200: ListMessagesResponse },
      },
    },
    async (request) => {
      const { id } = request.params;
      await channels.requireMember(id, request.user.id);
      const { before, limit } = request.query;
      return messages.history(id, limit, before);
    },
  );

  app.post(
    '/channels/:id/messages',
    {
      config: { scope: 'messages.write' },
      schema: { params: ChannelParams, body: SendMessageBody, response: { 201: Message } },
    },
    async (request, reply) => {
      const message = await messages.send({
        author: request.user,
        channelId: request.params.id,
        ...request.body,
      });
      return reply.code(201).send(message);
    },
  );

  app.patch(
    '/messages/:id',
    {
      config: { scope: 'messages.write' },
      schema: { params: MessageParams, body: EditMessageBody, response: { 200: Message } },
    },
    (request) => messages.edit(request.user, request.params.id, request.body.content),
  );

  app.delete(
    '/messages/:id',
    { config: { scope: 'messages.write' }, schema: { params: MessageParams } },
    async (request, reply) => {
      await messages.delete(request.user, request.params.id);
      return reply.code(204).send();
    },
  );

  done();
};
