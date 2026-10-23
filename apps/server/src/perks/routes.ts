import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { GrantPerkBody, Id, MyPerksResponse, PerkParams, PerksOverview } from '@harmony/shared';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { PerkService } from './service.js';

export const perkRoutes: FastifyPluginCallbackZod<{ perks: PerkService }> = (
  app,
  { perks },
  done,
) => {
  app.get(
    '/me/perks',
    { config: { humanOnly: true }, schema: { response: { 200: MyPerksResponse } } },
    async (request) => ({
      perks: [...(await perks.effective(request.user.id))],
      explicit: [...(await perks.explicit(request.user.id))],
    }),
  );

  const adminOnly = (isAdmin: boolean) => {
    if (!isAdmin) throw new AppError(403, 'forbidden', 'Instance admins only');
  };

  app.get(
    '/admin/perks',
    { config: { humanOnly: true }, schema: { response: { 200: PerksOverview } } },
    async (request) => {
      adminOnly(request.user.isAdmin);
      return perks.overview();
    },
  );

  app.put(
    '/admin/users/:userId/perks',
    {
      config: { humanOnly: true },
      schema: { params: z.object({ userId: Id }), body: GrantPerkBody },
    },
    async (request, reply) => {
      adminOnly(request.user.isAdmin);
      await perks.grant(request.params.userId, request.body.perk, request.user.id);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/admin/users/:userId/perks/:perk',
    { config: { humanOnly: true }, schema: { params: PerkParams } },
    async (request, reply) => {
      adminOnly(request.user.isAdmin);
      await perks.revoke(request.params.userId, request.params.perk);
      return reply.code(204).send();
    },
  );
  done();
};
