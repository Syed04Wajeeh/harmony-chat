import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  ChannelParams,
  EditMessageBody,
  ListMessagesQuery,
  ListMessagesResponse,
  Message,
  MessageParams,
  PinsResponse,
  ReactionParams,
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

  app.get(
    '/channels/:id/pins',
    { schema: { params: ChannelParams, response: { 200: PinsResponse } } },
    async (request) => ({ messages: await messages.pins(request.user, request.params.id) }),
  );

  app.patch(
    '/messages/:id',
    {
      schema: { params: MessageParams, body: EditMessageBody, response: { 200: Message } },
    },
    (request) => messages.edit(request.user, request.params.id, request.body.content),
  );

  app.delete('/messages/:id', { schema: { params: MessageParams } }, async (request, reply) => {
    await messages.delete(request.user, request.params.id);
    return reply.code(204).send();
  });

  app.put(
    '/messages/:id/reactions/:emoji',
    { schema: { params: ReactionParams } },
    async (request, reply) => {
      await messages.addReaction(request.user, request.params.id, request.params.emoji);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/messages/:id/reactions/:emoji',
    { schema: { params: ReactionParams } },
    async (request, reply) => {
      await messages.removeReaction(request.user, request.params.id, request.params.emoji);
      return reply.code(204).send();
    },
  );

  app.put(
    '/messages/:id/pin',
    { schema: { params: MessageParams, response: { 200: Message } } },
    (request) => messages.setPinned(request.user, request.params.id, true),
  );

  app.delete(
    '/messages/:id/pin',
    { schema: { params: MessageParams, response: { 200: Message } } },
    (request) => messages.setPinned(request.user, request.params.id, false),
  );
  done();
};
