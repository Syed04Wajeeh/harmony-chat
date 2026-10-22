import type { FastifyPluginCallback } from 'fastify';
import { handleConnection, type ConnectionDeps } from './connection.js';

export const realtimeRoutes: FastifyPluginCallback<ConnectionDeps> = (app, deps, done) => {
  app.get('/ws', { websocket: true, config: { scope: 'any' } }, (socket, request) => {
    handleConnection(socket, request.user, request.bot, request.log, deps);
  });
  done();
};
