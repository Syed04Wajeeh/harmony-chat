import fp from 'fastify-plugin';
import type { BotScope, DirectoryUser } from '@harmony/shared';
import type { BotAuthenticator, BotPrincipal } from '../bots/auth.js';
import { AppError } from '../errors.js';
import { authenticate, botCredential, isAuthFailure, type AuthPolicy } from './policy.js';
import type { UserStore } from './user-store.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: DirectoryUser;
    /** Set when the request authenticated with a bot token. */
    bot: BotPrincipal | null;
  }
  interface FastifyContextConfig {
    /** The scope a bot needs for this route; `any` lets every bot through. Unset denies bots. */
    scope?: BotScope | 'any';
    /** Bots get 403 `human_only`. */
    humanOnly?: boolean;
    /** The path carries its own credential (webhook and interaction tokens); skip authentication. */
    public?: boolean;
  }
}

export interface AuthPluginOptions {
  policy: AuthPolicy;
  users: UserStore;
  bots: BotAuthenticator;
}

/** Authenticates every request in the registering scope, including WebSocket upgrades. */
export const authPlugin = fp<AuthPluginOptions>(
  (app, { policy, users, bots }, done) => {
    if (!policy.proxySecret && !policy.devIdentity) {
      throw new Error('Auth requires a proxy secret or a development identity');
    }
    app.decorateRequest('user');
    app.decorateRequest('bot', null);

    app.addHook('onRequest', async (request) => {
      const config = request.routeOptions.config;
      if (config.public) return;

      // A bot token decides everything: Tailscale-* headers and the Origin check are not even
      // looked at. A cross-site page cannot attach an Authorization header without a CORS
      // preflight, and the app sends no CORS headers, so ambient browser requests cannot use it.
      const credential = botCredential(request.headers);
      if (credential !== null) {
        const found = await bots.authenticate(credential);
        if (!found) throw new AppError(401, 'invalid_token', 'Invalid bot token');
        request.user = found.user;
        request.bot = found.bot;
        if (config.humanOnly) {
          throw new AppError(403, 'human_only', 'Bots cannot use this endpoint');
        }
        if (!config.scope) {
          throw new AppError(403, 'bot_not_allowed', 'Bots cannot use this endpoint');
        }
        if (config.scope !== 'any' && !found.bot.scopes.includes(config.scope)) {
          throw new AppError(403, 'missing_scope', `This bot lacks the ${config.scope} scope`);
        }
        return;
      }

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
