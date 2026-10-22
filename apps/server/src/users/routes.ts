import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { ListUsersResponse, Me, PresenceResponse, UpdateMeBody } from '@harmony/shared';
import type { UserStore } from '../auth/user-store.js';
import type { PresenceService } from '../presence/service.js';

export interface UserRoutesOptions {
  users: UserStore;
  presence: PresenceService;
}

export const userRoutes: FastifyPluginCallbackZod<UserRoutesOptions> = (
  app,
  { users, presence },
  done,
) => {
  app.get('/me', { config: { scope: 'any' }, schema: { response: { 200: Me } } }, (request) =>
    users.getMe(request.user),
  );

  app.patch(
    '/me',
    { config: { humanOnly: true }, schema: { body: UpdateMeBody, response: { 200: Me } } },
    async (request) => {
      const { status } = request.body;
      await users.setStatus(request.user.id, status);
      await presence.statusChanged(request.user.id, status);
      return users.getMe(request.user);
    },
  );

  app.get(
    '/users',
    { config: { scope: 'channels.read' }, schema: { response: { 200: ListUsersResponse } } },
    async (request) => ({
      users: await users.listVisibleTo(request.user.id),
    }),
  );

  app.get(
    '/presence',
    { config: { scope: 'channels.read' }, schema: { response: { 200: PresenceResponse } } },
    async () => ({
      presence: await presence.snapshot(),
    }),
  );
  done();
};
