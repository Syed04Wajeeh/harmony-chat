import { z } from 'zod';
import { MAX_CUSTOM_CSS_BYTES, cssByteLength } from './css.js';

export const THEME_MODES = ['system', 'dark', 'light'] as const;
export const DENSITIES = ['compact', 'cozy', 'comfortable'] as const;
export const PANEL_STYLES = ['floating', 'flat'] as const;
export const REDUCED_MOTION = ['system', 'on', 'off'] as const;

/** Bundled typefaces for message text; each has a matching @fontsource import in the web client. */
export const MESSAGE_FONTS = ['manrope', 'inter', 'atkinson', 'plex'] as const;
export const MIN_FONT_SCALE = 0.875;
export const MAX_FONT_SCALE = 1.25;

export const DEFAULT_THEME_ID = 'harmony-dark';

const CustomCss = z.string().refine((css) => cssByteLength(css) <= MAX_CUSTOM_CSS_BYTES, {
  message: 'Custom CSS is too large',
});

const appearanceShape = {
  mode: z.enum(THEME_MODES),
  /** A preset id, or the uuid of one of the user's own themes. */
  themeId: z.string().min(1).max(40),
  density: z.enum(DENSITIES),
  panels: z.enum(PANEL_STYLES),
  fontScale: z.number().min(MIN_FONT_SCALE).max(MAX_FONT_SCALE),
  messageFont: z.enum(MESSAGE_FONTS),
  useGuildAccent: z.boolean(),
  reducedMotion: z.enum(REDUCED_MOTION),
  customCssEnabled: z.boolean(),
  customCss: CustomCss,
};

const behaviorShape = {
  timeFormat: z.enum(['12h', '24h']),
  showAvatars: z.boolean(),
  messageGrouping: z.boolean(),
  memberListDefault: z.enum(['open', 'closed']),
  sendOnEnter: z.boolean(),
  /** Reserved: link previews are not generated yet. */
  linkPreviews: z.boolean(),
  /** Minutes without input before presence goes idle; 0 never. */
  autoIdleMinutes: z.number().int().min(0).max(240),
};

export const Appearance = z.object(appearanceShape);
export type Appearance = z.infer<typeof Appearance>;
export const AppearancePatch = Appearance.partial();
export type AppearancePatch = z.infer<typeof AppearancePatch>;

export const Behavior = z.object(behaviorShape);
export type Behavior = z.infer<typeof Behavior>;
export const BehaviorPatch = Behavior.partial();
export type BehaviorPatch = z.infer<typeof BehaviorPatch>;

export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'system',
  themeId: DEFAULT_THEME_ID,
  density: 'cozy',
  panels: 'floating',
  fontScale: 1,
  messageFont: 'manrope',
  useGuildAccent: true,
  reducedMotion: 'system',
  customCssEnabled: false,
  customCss: '',
};

export const DEFAULT_BEHAVIOR: Behavior = {
  timeFormat: '12h',
  showAvatars: true,
  messageGrouping: true,
  memberListDefault: 'open',
  sendOnEnter: true,
  linkPreviews: true,
  autoIdleMinutes: 10,
};

export const UserSettings = z.object({
  appearance: Appearance,
  behavior: Behavior,
  /** Bumped by every successful save; sent back on the next one. */
  version: z.number().int().min(0),
  updatedAt: z.iso.datetime().nullable(),
});
export type UserSettings = z.infer<typeof UserSettings>;

export const DEFAULT_SETTINGS: UserSettings = {
  appearance: DEFAULT_APPEARANCE,
  behavior: DEFAULT_BEHAVIOR,
  version: 0,
  updatedAt: null,
};

/** The fields changing, plus the version they were based on. */
export const PatchSettingsBody = z
  .object({
    version: z.number().int().min(0),
    appearance: AppearancePatch.optional(),
    behavior: BehaviorPatch.optional(),
  })
  .refine((body) => body.appearance !== undefined || body.behavior !== undefined, {
    message: 'Nothing to update',
  });
export type PatchSettingsBody = z.infer<typeof PatchSettingsBody>;

export type SettingsPatch = Pick<PatchSettingsBody, 'appearance' | 'behavior'>;

/** Applies a patch field by field; undefined values leave the field alone. */
export function mergeSettings(settings: UserSettings, patch: SettingsPatch): UserSettings {
  const defined = <T extends object>(values: T | undefined) =>
    Object.fromEntries(Object.entries(values ?? {}).filter(([, value]) => value !== undefined));
  return {
    ...settings,
    appearance: { ...settings.appearance, ...defined(patch.appearance) },
    behavior: { ...settings.behavior, ...defined(patch.behavior) },
  };
}

/** Stored or foreign values with defaults filled in for anything missing or invalid, one field at a time. */
export function normalizeSettings<S extends z.ZodObject>(
  schema: S,
  defaults: z.infer<S>,
  raw: unknown,
): z.infer<S> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = (field as z.ZodType).safeParse(input[key]);
    if (parsed.success) result[key] = parsed.data;
  }
  return result as z.infer<S>;
}

/** Overlays `later` on `earlier` so two unsent patches become one. */
export function combinePatches(earlier: SettingsPatch, later: SettingsPatch): SettingsPatch {
  return {
    ...((earlier.appearance ?? later.appearance) && {
      appearance: { ...earlier.appearance, ...later.appearance },
    }),
    ...((earlier.behavior ?? later.behavior) && {
      behavior: { ...earlier.behavior, ...later.behavior },
    }),
  };
}
