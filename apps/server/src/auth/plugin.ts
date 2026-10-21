import fp from 'fastify-plugin';
import type { DirectoryUser } from '@harmony/shared';
import { AppError } from '../errors.js';
import { authenticate, isAuthFailure, type AuthPolicy } from './policy.js';
import type { UserStore } from './user-store.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: DirectoryUser;
  }
}

export interface AuthPluginOptions {
  policy: AuthPolicy;
  users: UserStore;
}

/** Authenticates every request in the registering scope, including WebSocket upgrades. */
export const authPlugin = fp<AuthPluginOptions>(
  (app, { policy, users }, done) => {
    if (!policy.proxySecret && !policy.devIdentity) {
      throw new Error('Auth requires a proxy secret or a development identity');
    }
    app.decorateRequest('user');

    app.addHook('onRequest', async (request) => {
      const result = authenticate(request, policy);
      if (isAuthFailure(result)) {
        throw new AppError(result.statusCode, result.code, result.message);
      }
      request.user = await users.resolve(result);
    });
    done();
  },
  { name: 'harmony-auth' },
);
