import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { PERKS, type Perk, type PerksOverview } from '@harmony/shared';
import type { Database } from '../db/schema.js';

/** Carries a user id; every instance drops that user's cached perks. */
export const PERKS_INVALIDATE_TOPIC = 'harmony:perks:invalidate';

const TTL_MS = 5 * 60_000;
const MAX_USERS = 5000;

interface Entry {
  loadedAt: number;
  explicit: Promise<Set<Perk>>;
}

/**
 * Perks are free and admin-granted: `PERKS_DEFAULT` applies to everyone, `user_perks` adds
 * grants for single users. The effective set is cached per user in process, like permissions,
 * and a grant or revoke tells every instance to forget the user over Redis.
 */
export class PerkService {
  private readonly cache = new Map<string, Entry>();
  readonly defaults: ReadonlySet<Perk>;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    defaults: readonly Perk[],
  ) {
    this.defaults = new Set(defaults);
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  async explicit(userId: string): Promise<ReadonlySet<Perk>> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.explicit;
    const explicit = this.load(userId);
    if (this.cache.size >= MAX_USERS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const entry: Entry = { loadedAt: Date.now(), explicit };
    this.cache.set(userId, entry);
    explicit.catch(() => {
      if (this.cache.get(userId) === entry) this.cache.delete(userId);
    });
    return explicit;
  }

  async effective(userId: string): Promise<Set<Perk>> {
    return new Set([...this.defaults, ...(await this.explicit(userId))]);
  }

  async has(userId: string, perk: Perk): Promise<boolean> {
    return this.defaults.has(perk) || (await this.explicit(userId)).has(perk);
  }

  async grant(userId: string, perk: Perk, grantedBy: string): Promise<void> {
    await this.db
      .insertInto('user_perks')
      .values({ user_id: userId, perk, granted_by: grantedBy })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await this.changed(userId);
  }

  async revoke(userId: string, perk: Perk): Promise<boolean> {
    const row = await this.db
      .deleteFrom('user_perks')
      .where('user_id', '=', userId)
      .where('perk', '=', perk)
      .returning('perk')
      .executeTakeFirst();
    await this.changed(userId);
    return row !== undefined;
  }

  async overview(): Promise<PerksOverview> {
    const users = await this.db
      .selectFrom('users')
      .leftJoin('user_perks', 'user_perks.user_id', 'users.id')
      .leftJoin('users as granter', 'granter.id', 'user_perks.granted_by')
      .select([
        'users.id',
        'users.login',
        'users.display_name',
        'user_perks.perk',
        'user_perks.granted_by',
        'user_perks.granted_at',
        'granter.display_name as granter_name',
      ])
      .where('users.kind', '=', 'human')
      .orderBy('users.display_name')
      .execute();
    const byId = new Map<string, PerksOverview['users'][number]>();
    for (const row of users) {
      const entry = byId.get(row.id) ?? {
        id: row.id,
        login: row.login,
        displayName: row.display_name,
        grants: [],
      };
      byId.set(row.id, entry);
      if (row.perk && PERKS.includes(row.perk as Perk)) {
        entry.grants.push({
          perk: row.perk as Perk,
          grantedBy: row.granted_by,
          grantedByName: row.granter_name,
          grantedAt: (row.granted_at ?? new Date()).toISOString(),
        });
      }
    }
    return { defaults: [...this.defaults], all: [...PERKS], users: [...byId.values()] };
  }

  private async changed(userId: string): Promise<void> {
    this.invalidate(userId);
    await this.redis.publish(PERKS_INVALIDATE_TOPIC, userId).catch(() => undefined);
  }

  private async load(userId: string): Promise<Set<Perk>> {
    const rows = await this.db
      .selectFrom('user_perks')
      .select('perk')
      .where('user_id', '=', userId)
      .execute();
    return new Set(rows.map((row) => row.perk).filter((p): p is Perk => PERKS.includes(p as Perk)));
  }
}
