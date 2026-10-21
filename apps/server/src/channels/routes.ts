import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  AddMemberBody,
  Channel,
  ChannelMemberParams,
  ChannelParams,
  ChannelSummary,
  ListDmsResponse,
  CreateDmBody,
  ListChannelsResponse,
  MarkReadBody,
  MembersResponse,
  ReadState,
  UpdateChannelBody,
} from '@harmony/shared';
import type { ChannelService } from './service.js';

export const channelRoutes: FastifyPluginCallbackZod<{ channels: ChannelService }> = (
  app,
  { channels },
  done,
) => {
  app.get(
    '/channels',
    { schema: { response: { 200: ListChannelsResponse } } },
    async (request) => ({ channels: await channels.listForUser(request.user.id) }),
  );

  app.get('/dms', { schema: { response: { 200: ListDmsResponse } } }, async (request) => ({
    channels: await channels.listForUser(request.user.id, { dmsOnly: true }),
  }));

  app.patch(
    '/channels/:id',
    { schema: { params: ChannelParams, body: UpdateChannelBody, response: { 200: Channel } } },
    (request) => channels.update(request.user, request.params.id, request.body),
  );

  app.post('/channels/:id/leave', { schema: { params: ChannelParams } }, async (request, reply) => {
    await channels.leave(request.user, request.params.id);
    return reply.code(204).send();
  });

  app.get(
    '/channels/:id/members',
    { schema: { params: ChannelParams, response: { 200: MembersResponse } } },
    async (request) => ({ members: await channels.members(request.user, request.params.id) }),
  );

  app.post(
    '/channels/:id/members',
    { schema: { params: ChannelParams, body: AddMemberBody } },
    async (request, reply) => {
      await channels.addMember(request.user, request.params.id, request.body.userId);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/channels/:id/members/:userId',
    { schema: { params: ChannelMemberParams } },
    async (request, reply) => {
      await channels.removeMember(request.user, request.params.id, request.params.userId);
      return reply.code(204).send();
    },
  );

  app.post(
    '/channels/:id/read',
    { schema: { params: ChannelParams, body: MarkReadBody, response: { 200: ReadState } } },
    (request) => channels.markRead(request.user, request.params.id, request.body.messageId),
  );

  app.post(
    '/dms',
    { schema: { body: CreateDmBody, response: { 200: ChannelSummary } } },
    (request) => channels.openDm(request.user, request.body.userId),
  );
  done();
};
