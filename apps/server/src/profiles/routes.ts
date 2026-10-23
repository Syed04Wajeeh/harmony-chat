import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  Id,
  MyEmojiResponse,
  ProfileQuery,
  UpdateProfileBody,
  UserProfileResponse,
} from '@harmony/shared';
import type { EmojiService } from '../emoji/service.js';
import type { ProfileService } from './service.js';

export const profileRoutes: FastifyPluginCallbackZod<{
  profiles: ProfileService;
  emoji: EmojiService;
}> = (app, { profiles, emoji }, done) => {
  app.get(
    '/users/:id/profile',
    {
      config: { scope: 'channels.read' },
      schema: {
        params: z.object({ id: Id }),
        querystring: ProfileQuery,
        response: { 200: UserProfileResponse },
      },
    },
    (request) => profiles.get(request.user, request.params.id, request.query.guildId),
  );

  app.patch(
    '/me/profile',
    { config: { humanOnly: true }, schema: { body: UpdateProfileBody } },
    async (request, reply) => {
      await profiles.update(request.user, request.body);
      return reply.code(204).send();
    },
  );

  app.get(
    '/me/emoji',
    { config: { humanOnly: true }, schema: { response: { 200: MyEmojiResponse } } },
    async (request) => ({ emoji: await emoji.listForUser(request.user.id) }),
  );
  done();
};
