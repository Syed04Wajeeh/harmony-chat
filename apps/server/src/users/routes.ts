import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { ListUsersResponse, Me, PresenceResponse, UpdateMeBody } from '@harmony/shared';
import type { UserStore } from '../auth/user-store.js';
import type { ProfileService } from '../profiles/service.js';
import type { PresenceService } from '../presence/service.js';

export interface UserRoutesOptions {
  users: UserStore;
  presence: PresenceService;
  profiles: ProfileService;
}

export const userRoutes: FastifyPluginCallbackZod<UserRoutesOptions> = (
  app,
  { users, presence, profiles },
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
    async (request) => {
      const visible = await users.listVisibleTo(request.user.id);
      return { users: visible, profiles: await profiles.summaries(visible.map((u) => u.id)) };
    },
  );

  app.get(
    '/presence',
    { config: { scope: 'channels.read' }, schema: { response: { 200: PresenceResponse } } },
    async (request) => ({
      // Only people who share a guild or a DM with the caller.
      presence: await presence.snapshotFor(request.user.id),
    }),
  );
  done();
};
