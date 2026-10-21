import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { ListChannelsResponse, User } from '@harmony/shared';
import type { ChannelService } from './service.js';

export const channelRoutes: FastifyPluginCallbackZod<{ channels: ChannelService }> = (
  app,
  { channels },
  done,
) => {
  app.get('/me', { schema: { response: { 200: User } } }, (request) => request.user);

  app.get('/channels', { schema: { response: { 200: ListChannelsResponse } } }, async () => ({
    channels: await channels.list(),
  }));
  done();
};
