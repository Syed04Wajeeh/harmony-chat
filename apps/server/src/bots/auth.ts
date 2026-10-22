import type { Kysely } from 'kysely';
import type { BotScope, DirectoryUser } from '@harmony/shared';
import type { Database } from '../db/schema.js';
import { parseBotToken, verifySecret } from './token.js';

export interface BotPrincipal {
  id: string;
  scopes: readonly BotScope[];
}

export interface BotAuthResult {
  user: DirectoryUser;
  bot: BotPrincipal;
}

const TOUCH_INTERVAL_MS = 60_000;
const MAX_TRACKED = 5000;
/** Compared against when the bot id is unknown, so lookups of real and fake ids cost the same. */
const DUMMY_HASH = Buffer.alloc(32);

/** Authenticates `Authorization: Bot` tokens and keeps `last_used_at` fresh at most once a minute. */
export class BotAuthenticator {
  private readonly touched = new Map<string, number>();

  constructor(private readonly db: Kysely<Database>) {}

  async authenticate(token: string): Promise<BotAuthResult | null> {
    const parsed = parseBotToken(token);
    if (!parsed) return null;
    const row = await this.db
      .selectFrom('bots')
      .innerJoin('users', 'users.id', 'bots.user_id')
      .select([
        'users.id',
        'users.login',
        'users.display_name',
        'users.avatar_url',
        'bots.token_hash',
        'bots.scopes',
      ])
      .where('bots.user_id', '=', parsed.botId)
      .executeTakeFirst();
    const valid = verifySecret(parsed.secret, row?.token_hash ?? DUMMY_HASH);
    if (!row || !valid) return null;

    this.touch(row.id);
    return {
      user: {
        id: row.id,
        login: row.login,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        isAdmin: false,
        isBot: true,
      },
      bot: { id: row.id, scopes: row.scopes as BotScope[] },
    };
  }

  private touch(botId: string): void {
    const now = Date.now();
    const last = this.touched.get(botId);
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
    if (this.touched.size >= MAX_TRACKED) this.touched.clear();
    this.touched.set(botId, now);
    void this.db
      .updateTable('bots')
      .set({ last_used_at: new Date(now) })
      .where('user_id', '=', botId)
      .execute()
      .catch(() => this.touched.delete(botId));
  }
}
