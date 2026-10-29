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
  SetChannelBotsBody,
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
    { config: { scope: 'channels.read' }, schema: { response: { 200: ListChannelsResponse } } },
    async (request) => ({ channels: await channels.listForUser(request.user.id) }),
  );

  app.get(
    '/dms',
    { config: { humanOnly: true }, schema: { response: { 200: ListDmsResponse } } },
    async (request) => ({
      channels: await channels.listForUser(request.user.id, { dmsOnly: true }),
    }),
  );

  app.patch(
    '/channels/:id',
    {
      config: { humanOnly: true },
      schema: { params: ChannelParams, body: UpdateChannelBody, response: { 200: Channel } },
    },
    (request) => channels.update(request.user, request.params.id, request.body),
  );

  app.put(
    '/channels/:id/bots',
    {
      config: { humanOnly: true },
      schema: { params: ChannelParams, body: SetChannelBotsBody, response: { 200: Channel } },
    },
    (request) => channels.setBots(request.user, request.params.id, request.body.botIds),
  );

  app.post(
    '/channels/:id/leave',
    { config: { humanOnly: true }, schema: { params: ChannelParams } },
    async (request, reply) => {
      await channels.leave(request.user, request.params.id);
      return reply.code(204).send();
    },
  );

  app.get(
    '/channels/:id/members',
    {
      config: { scope: 'channels.read' },
      schema: { params: ChannelParams, response: { 200: MembersResponse } },
    },
    async (request) => ({ members: await channels.members(request.user, request.params.id) }),
  );

  app.post(
    '/channels/:id/members',
    { config: { humanOnly: true }, schema: { params: ChannelParams, body: AddMemberBody } },
    async (request, reply) => {
      await channels.addMember(request.user, request.params.id, request.body.userId);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/channels/:id/members/:userId',
    { config: { humanOnly: true }, schema: { params: ChannelMemberParams } },
    async (request, reply) => {
      await channels.removeMember(request.user, request.params.id, request.params.userId);
      return reply.code(204).send();
    },
  );

  app.post(
    '/channels/:id/read',
    {
      config: { humanOnly: true },
      schema: { params: ChannelParams, body: MarkReadBody, response: { 200: ReadState } },
    },
    (request) => channels.markRead(request.user, request.params.id, request.body.messageId),
  );

  app.post(
    '/dms',
    {
      config: { humanOnly: true },
      schema: { body: CreateDmBody, response: { 200: ChannelSummary } },
    },
    (request) => channels.openDm(request.user, request.body.userId),
  );
  done();
};
