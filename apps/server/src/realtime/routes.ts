import type { FastifyPluginCallback } from 'fastify';
import { handleConnection, type ConnectionDeps } from './connection.js';

export const realtimeRoutes: FastifyPluginCallback<ConnectionDeps> = (app, deps, done) => {
  app.get('/ws', { websocket: true }, (socket, request) => {
    handleConnection(socket, request.user, request.log, deps);
  });
  done();
};
