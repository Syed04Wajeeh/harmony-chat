import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { GuildParams, SendInvitesBody, SendInvitesResponse } from '@harmony/shared';
import type { InviteCardService } from './invite-cards.js';

export const inviteCardRoutes: FastifyPluginCallbackZod<{ cards: InviteCardService }> = (
  app,
  { cards },
  done,
) => {
  app.post(
    '/guilds/:id/invites/send',
    {
      config: { humanOnly: true },
      schema: {
        params: GuildParams,
        body: SendInvitesBody,
        response: { 200: SendInvitesResponse },
      },
    },
    (request) => cards.send(request.user, request.params.id, request.body.userIds),
  );
  done();
};
