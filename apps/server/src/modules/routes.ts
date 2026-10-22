import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  GuildModule,
  GuildModuleParams,
  GuildModulesResponse,
  GuildParams,
  UpdateGuildModuleBody,
} from '@harmony/shared';
import type { GuildService } from '../guilds/service.js';
import type { PermissionService } from '../permissions/service.js';
import type { EventBus } from '../realtime/events.js';
import type { GuildModuleState } from './guild-state.js';

export interface ModuleRoutesOptions {
  state: GuildModuleState;
  guilds: GuildService;
  events: EventBus;
  perms: PermissionService;
}

export const moduleRoutes: FastifyPluginCallbackZod<ModuleRoutesOptions> = (
  app,
  { state, guilds, events, perms },
  done,
) => {
  app.get(
    '/guilds/:id/modules',
    {
      config: { scope: 'channels.read' },
      schema: { params: GuildParams, response: { 200: GuildModulesResponse } },
    },
    async (request) => {
      await guilds.requireMember(request.params.id, request.user.id);
      return { modules: await state.list(request.params.id) };
    },
  );

  app.put(
    '/guilds/:id/modules/:moduleId',
    {
      config: { humanOnly: true },
      schema: {
        params: GuildModuleParams,
        body: UpdateGuildModuleBody,
        response: { 200: GuildModule },
      },
    },
    async (request) => {
      const { id: guildId, moduleId } = request.params;
      await perms.require(request.user, guildId, 'manage_guild');
      const updated = await state.update(guildId, moduleId, request.body);
      await guilds.toMembers(guildId, (userId) =>
        events.toUser(userId, {
          type: 'guild.modules_updated',
          guildId,
          moduleId,
          enabled: updated.enabled,
          settings: updated.settings,
        }),
      );
      const entry = (await state.list(guildId)).find((module) => module.id === moduleId);
      if (!entry) throw new Error(`module ${moduleId} vanished`);
      return entry;
    },
  );
  done();
};
