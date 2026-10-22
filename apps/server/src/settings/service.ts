import type { Kysely } from 'kysely';
import {
  Appearance,
  Behavior,
  DEFAULT_APPEARANCE,
  DEFAULT_BEHAVIOR,
  DEFAULT_SETTINGS,
  DEFAULT_THEME_ID,
  MAX_CUSTOM_THEMES,
  findPreset,
  mergeSettings,
  normalizeSettings,
  sanitizeCss,
  type CustomTheme,
  type PatchSettingsBody,
  type ThemeInput,
  type UserSettings,
} from '@harmony/shared';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { EventBus } from '../realtime/events.js';

interface ThemeRow {
  id: string;
  name: string;
  base: 'dark' | 'light';
  tokens: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

const toTheme = (row: ThemeRow): CustomTheme => ({
  id: row.id,
  name: row.name,
  base: row.base,
  tokens: row.tokens,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const conflict = () =>
  new AppError(409, 'version_conflict', 'Your settings changed elsewhere; reload and try again');
const themeNotFound = () => new AppError(404, 'theme_not_found', 'Theme not found');

/** Per-user preferences and custom themes. Loaded once per session, never per message. */
export class SettingsService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly events: EventBus,
  ) {}

  async get(userId: string): Promise<UserSettings> {
    const row = await this.db
      .selectFrom('user_settings')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) return DEFAULT_SETTINGS;
    return {
      appearance: normalizeSettings(Appearance, DEFAULT_APPEARANCE, row.appearance),
      behavior: normalizeSettings(Behavior, DEFAULT_BEHAVIOR, row.behavior),
      version: row.version,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /** Applies a patch if `body.version` is still current; otherwise 409 and the client refetches. */
  async patch(userId: string, body: PatchSettingsBody): Promise<UserSettings> {
    const current = await this.get(userId);
    if (body.version !== current.version) throw conflict();
    const merged = mergeSettings(current, body);
    // The stored text is always the sanitized text.
    merged.appearance.customCss = sanitizeCss(merged.appearance.customCss).css;
    if (body.appearance?.themeId !== undefined)
      await this.requireTheme(userId, body.appearance.themeId);

    const values = {
      appearance: JSON.stringify(merged.appearance),
      behavior: JSON.stringify(merged.behavior),
    };
    const saved =
      current.version === 0
        ? await this.db
            .insertInto('user_settings')
            .values({ user_id: userId, ...values })
            .onConflict((oc) => oc.column('user_id').doNothing())
            .returning(['version', 'updated_at'])
            .executeTakeFirst()
        : await this.db
            .updateTable('user_settings')
            .set((eb) => ({ ...values, version: eb('version', '+', 1), updated_at: new Date() }))
            .where('user_id', '=', userId)
            .where('version', '=', current.version)
            .returning(['version', 'updated_at'])
            .executeTakeFirst();
    if (!saved) throw conflict();

    const settings = {
      ...merged,
      version: saved.version,
      updatedAt: saved.updated_at.toISOString(),
    };
    await this.events.toUser(userId, { type: 'settings.updated', settings });
    return settings;
  }

  private async requireTheme(userId: string, themeId: string): Promise<void> {
    if (findPreset(themeId)) return;
    const owned = /^[0-9a-f-]{36}$/i.test(themeId)
      ? await this.db
          .selectFrom('user_themes')
          .select('id')
          .where('id', '=', themeId)
          .where('user_id', '=', userId)
          .executeTakeFirst()
      : undefined;
    if (!owned) throw new AppError(400, 'invalid_theme', 'That theme does not exist');
  }

  async listThemes(userId: string): Promise<CustomTheme[]> {
    const rows = await this.db
      .selectFrom('user_themes')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toTheme);
  }

  async createTheme(userId: string, input: ThemeInput): Promise<CustomTheme> {
    const row = await this.db.transaction().execute(async (trx) => {
      // Serializes concurrent creates for one user so the limit holds.
      await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const { count } = await trx
        .selectFrom('user_themes')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      if (Number(count) >= MAX_CUSTOM_THEMES) {
        throw new AppError(
          400,
          'theme_limit',
          `You can keep up to ${String(MAX_CUSTOM_THEMES)} themes`,
        );
      }
      return trx
        .insertInto('user_themes')
        .values({ ...input, user_id: userId, tokens: JSON.stringify(input.tokens) })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    await this.publishThemes(userId);
    return toTheme(row);
  }

  async updateTheme(userId: string, id: string, input: ThemeInput): Promise<CustomTheme> {
    const row = await this.db
      .updateTable('user_themes')
      .set({ ...input, tokens: JSON.stringify(input.tokens), updated_at: new Date() })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw themeNotFound();
    await this.publishThemes(userId);
    return toTheme(row);
  }

  async deleteTheme(userId: string, id: string): Promise<void> {
    const deleted = await this.db
      .deleteFrom('user_themes')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (deleted.numDeletedRows === 0n) throw themeNotFound();
    const settings = await this.get(userId);
    if (settings.appearance.themeId === id) {
      await this.patch(userId, {
        version: settings.version,
        appearance: { themeId: DEFAULT_THEME_ID },
      });
    }
    await this.publishThemes(userId);
  }

  private async publishThemes(userId: string): Promise<void> {
    await this.events.toUser(userId, {
      type: 'themes.updated',
      themes: await this.listThemes(userId),
    });
  }
}
