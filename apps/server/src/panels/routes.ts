import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  AppendPointsBody,
  ChannelParams,
  ListPanelsResponse,
  Panel,
  PanelIdParams,
  PanelKeyParams,
  PutPanelBody,
  UpdatePanelBody,
} from '@harmony/shared';
import type { PanelService } from './service.js';

export const panelRoutes: FastifyPluginCallbackZod<{ panels: PanelService }> = (
  app,
  { panels },
  done,
) => {
  app.get(
    '/channels/:id/panels',
    {
      config: { scope: 'channels.read' },
      schema: { params: ChannelParams, response: { 200: ListPanelsResponse } },
    },
    async (request) => ({ panels: await panels.list(request.user, request.params.id) }),
  );

  // The three bot routes below act as the bot that authenticated; the key is that bot's own.
  app.put(
    '/channels/:id/panels/:key',
    {
      config: { scope: 'panels.write' },
      schema: { params: PanelKeyParams, body: PutPanelBody, response: { 200: Panel } },
    },
    (request) => panels.put(request.user, request.params.id, request.params.key, request.body),
  );

  app.post(
    '/channels/:id/panels/:key/points',
    {
      config: { scope: 'panels.write' },
      schema: { params: PanelKeyParams, body: AppendPointsBody, response: { 200: Panel } },
    },
    (request) => panels.append(request.user, request.params.id, request.params.key, request.body),
  );

  app.delete(
    '/channels/:id/panels/:key',
    { config: { scope: 'panels.write' }, schema: { params: PanelKeyParams } },
    async (request, reply) => {
      await panels.removeByKey(request.user, request.params.id, request.params.key);
      return reply.code(204).send();
    },
  );

  app.patch(
    '/panels/:panelId',
    {
      config: { humanOnly: true },
      schema: { params: PanelIdParams, body: UpdatePanelBody, response: { 200: Panel } },
    },
    (request) => panels.setPinned(request.user, request.params.panelId, request.body.pinned),
  );

  app.delete(
    '/panels/:panelId',
    { config: { humanOnly: true }, schema: { params: PanelIdParams } },
    async (request, reply) => {
      await panels.removeById(request.user, request.params.panelId);
      return reply.code(204).send();
    },
  );
  done();
};
