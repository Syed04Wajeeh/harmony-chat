import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  ChannelSummary,
  CreateChannelBody,
  CreateGuildBody,
  CreateInviteBody,
  Guild,
  GuildMembersResponse,
  GuildParams,
  GuildSummary,
  Invite,
  InviteParams,
  InvitePreview,
  ListChannelsResponse,
  ListGuildsResponse,
  UpdateGuildBody,
} from '@harmony/shared';
import type { ChannelService } from '../channels/service.js';
import type { GuildService } from './service.js';

export interface GuildRoutesOptions {
  guilds: GuildService;
  channels: ChannelService;
}

export const guildRoutes: FastifyPluginCallbackZod<GuildRoutesOptions> = (
  app,
  { guilds, channels },
  done,
) => {
  app.get(
    '/guilds',
    { config: { scope: 'channels.read' }, schema: { response: { 200: ListGuildsResponse } } },
    async (request) => ({
      guilds: await guilds.list(request.user.id),
    }),
  );

  app.post(
    '/guilds',
    {
      config: { humanOnly: true },
      schema: { body: CreateGuildBody, response: { 201: GuildSummary } },
    },
    async (request, reply) =>
      reply.code(201).send(await guilds.create(request.user, request.body.name)),
  );

  app.patch(
    '/guilds/:id',
    {
      config: { humanOnly: true },
      schema: { params: GuildParams, body: UpdateGuildBody, response: { 200: Guild } },
    },
    (request) => guilds.update(request.user, request.params.id, request.body),
  );

  app.delete(
    '/guilds/:id',
    { config: { humanOnly: true }, schema: { params: GuildParams } },
    async (request, reply) => {
      await guilds.delete(request.user, request.params.id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/guilds/:id/leave',
    { config: { humanOnly: true }, schema: { params: GuildParams } },
    async (request, reply) => {
      await guilds.leave(request.user, request.params.id);
      return reply.code(204).send();
    },
  );

  app.get(
    '/guilds/:id/members',
    {
      config: { scope: 'channels.read' },
      schema: { params: GuildParams, response: { 200: GuildMembersResponse } },
    },
    async (request) => ({ members: await guilds.members(request.user, request.params.id) }),
  );

  app.get(
    '/guilds/:id/channels',
    {
      config: { scope: 'channels.read' },
      schema: { params: GuildParams, response: { 200: ListChannelsResponse } },
    },
    async (request) => ({ channels: await guilds.channelsOf(request.user, request.params.id) }),
  );

  app.post(
    '/guilds/:id/channels',
    {
      config: { humanOnly: true },
      schema: { params: GuildParams, body: CreateChannelBody, response: { 201: ChannelSummary } },
    },
    async (request, reply) =>
      reply.code(201).send(await channels.create(request.user, request.params.id, request.body)),
  );

  app.post(
    '/guilds/:id/invites',
    {
      config: { humanOnly: true },
      schema: { params: GuildParams, body: CreateInviteBody, response: { 201: Invite } },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await guilds.createInvite(request.user, request.params.id, request.body)),
  );

  app.get(
    '/invites/:code',
    {
      config: { humanOnly: true },
      schema: { params: InviteParams, response: { 200: InvitePreview } },
    },
    (request) => guilds.previewInvite(request.user, request.params.code),
  );

  app.post(
    '/invites/:code/accept',
    {
      config: { humanOnly: true },
      schema: { params: InviteParams, response: { 200: GuildSummary } },
    },
    (request) => guilds.acceptInvite(request.user, request.params.code),
  );
  done();
};
