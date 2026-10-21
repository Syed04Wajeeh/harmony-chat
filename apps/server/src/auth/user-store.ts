import type { Kysely } from 'kysely';
import type { User } from '@harmony/shared';
import type { Database } from '../db/schema.js';
import type { Identity } from './policy.js';

interface CacheEntry {
  user: User;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 1000;

/**
 * Resolves a proxy-supplied identity to a user row. Results are cached in-process so
 * a request normally costs no query; the row is only written when the identity changed.
 */
export class UserStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly ttlMs = 60_000,
  ) {}

  async resolve(identity: Identity): Promise<User> {
    const cached = this.cache.get(identity.login);
    if (cached && cached.expiresAt > Date.now() && matches(cached.user, identity)) {
      return cached.user;
    }

    const existing = await this.db
      .selectFrom('users')
      .selectAll()
      .where('login', '=', identity.login)
      .executeTakeFirst();
    const row =
      existing?.display_name === identity.displayName && existing.avatar_url === identity.avatarUrl
        ? existing
        : await this.db
            .insertInto('users')
            .values({
              login: identity.login,
              display_name: identity.displayName,
              avatar_url: identity.avatarUrl,
            })
            .onConflict((oc) =>
              oc.column('login').doUpdateSet({
                display_name: identity.displayName,
                avatar_url: identity.avatarUrl,
              }),
            )
            .returningAll()
            .executeTakeFirstOrThrow();

    const user: User = {
      id: row.id,
      login: row.login,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    };
    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
    this.cache.set(identity.login, { user, expiresAt: Date.now() + this.ttlMs });
    return user;
  }
}

function matches(user: User, identity: Identity): boolean {
  return user.displayName === identity.displayName && user.avatarUrl === identity.avatarUrl;
}
