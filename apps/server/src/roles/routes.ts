import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  ChannelParams,
  CreateRoleBody,
  EffectivePermissions,
  EffectivePermissionsQuery,
  GuildMemberParams,
  GuildParams,
  ListOverwritesResponse,
  ListRolesResponse,
  MemberRoleParams,
  NicknameBody,
  OverwriteParams,
  PutOverwriteBody,
  ReorderRolesBody,
  Role,
  RoleParams,
  TransferGuildBody,
  UpdateRoleBody,
  Guild,
} from '@harmony/shared';
import type { GuildService } from '../guilds/service.js';
import type { PermissionService } from '../permissions/service.js';
import type { RoleService } from './service.js';

export interface RoleRoutesOptions {
  roles: RoleService;
  guilds: GuildService;
  perms: PermissionService;
}

export const roleRoutes: FastifyPluginCallbackZod<RoleRoutesOptions> = (
  app,
  { roles, guilds, perms },
  done,
) => {
  app.get(
    '/guilds/:id/roles',
    {
      config: { scope: 'channels.read' },
      schema: { params: GuildParams, response: { 200: ListRolesResponse } },
    },
    async (request) => ({ roles: await roles.list(request.user, request.params.id) }),
  );

  app.post(
    '/guilds/:id/roles',
    {
      config: { humanOnly: true },
      schema: { params: GuildParams, body: CreateRoleBody, response: { 201: Role } },
    },
    async (request, reply) =>
      reply.code(201).send(await roles.create(request.user, request.params.id, request.body)),
  );

  app.patch(
    '/guilds/:id/roles/order',
    {
      config: { humanOnly: true },
      schema: { params: GuildParams, body: ReorderRolesBody, response: { 200: ListRolesResponse } },
    },
    async (request) => ({
      roles: await roles.reorder(request.user, request.params.id, request.body.roleIds),
    }),
  );

  app.patch(
    '/guilds/:id/roles/:roleId',
    {
      config: { humanOnly: true },
      schema: { params: RoleParams, body: UpdateRoleBody, response: { 200: Role } },
    },
    (request) => roles.update(request.user, request.params.id, request.params.roleId, request.body),
  );

  app.delete(
    '/guilds/:id/roles/:roleId',
    { config: { humanOnly: true }, schema: { params: RoleParams } },
    async (request, reply) => {
      await roles.remove(request.user, request.params.id, request.params.roleId);
      return reply.code(204).send();
    },
  );

  app.put(
    '/guilds/:id/members/:userId/roles/:roleId',
    { config: { humanOnly: true }, schema: { params: MemberRoleParams } },
    async (request, reply) => {
      const { id, userId, roleId } = request.params;
      await roles.assign(request.user, id, userId, roleId);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/guilds/:id/members/:userId/roles/:roleId',
    { config: { humanOnly: true }, schema: { params: MemberRoleParams } },
    async (request, reply) => {
      const { id, userId, roleId } = request.params;
      await roles.revoke(request.user, id, userId, roleId);
      return reply.code(204).send();
    },
  );

  app.patch(
    '/guilds/:id/members/:userId',
    { config: { humanOnly: true }, schema: { params: GuildMemberParams, body: NicknameBody } },
    async (request, reply) => {
      const { id, userId } = request.params;
      await guilds.setNickname(request.user, id, userId, request.body);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/guilds/:id/members/:userId',
    { config: { humanOnly: true }, schema: { params: GuildMemberParams } },
    async (request, reply) => {
      await guilds.kick(request.user, request.params.id, request.params.userId);
      return reply.code(204).send();
    },
  );

  app.post(
    '/guilds/:id/transfer',
    {
      config: { humanOnly: true },
      schema: { params: GuildParams, body: TransferGuildBody, response: { 200: Guild } },
    },
    (request) => guilds.transfer(request.user, request.params.id, request.body.userId),
  );

  app.get(
    '/guilds/:id/permissions/@me',
    {
      config: { scope: 'channels.read' },
      schema: {
        params: GuildParams,
        querystring: EffectivePermissionsQuery,
        response: { 200: EffectivePermissions },
      },
    },
    (request) => perms.effective(request.user, request.params.id, request.query.channelId),
  );

  app.get(
    '/channels/:id/overwrites',
    {
      config: { humanOnly: true },
      schema: { params: ChannelParams, response: { 200: ListOverwritesResponse } },
    },
    async (request) => ({ overwrites: await roles.overwrites(request.user, request.params.id) }),
  );

  app.put(
    '/channels/:id/overwrites/:targetType/:targetId',
    {
      config: { humanOnly: true },
      schema: {
        params: OverwriteParams,
        body: PutOverwriteBody,
        response: { 200: ListOverwritesResponse },
      },
    },
    async (request) => {
      const { id, targetType, targetId } = request.params;
      return {
        overwrites: await roles.putOverwrite(request.user, id, targetType, targetId, request.body),
      };
    },
  );

  app.delete(
    '/channels/:id/overwrites/:targetType/:targetId',
    {
      config: { humanOnly: true },
      schema: { params: OverwriteParams, response: { 200: ListOverwritesResponse } },
    },
    async (request) => {
      const { id, targetType, targetId } = request.params;
      return {
        overwrites: await roles.removeOverwrite(request.user, id, targetType, targetId),
      };
    },
  );
  done();
};
